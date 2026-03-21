/**
 * FashionPilot — 服务端 (Node.js + Express)
 * 端口: 3000 (PM2 守护)
 * 包含: 所有业务 API + Sorftime MCP + AI (Claude/DeepSeek)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');
// Node.js 18+ 内置全局 fetch，无需 node-fetch

const app = express();
const PORT = process.env.PORT || 3000;

// ====== 中间件 ======
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ====== 环境变量 ======
const mcpKey = process.env.SORFTIME_MCP_KEY;
const openrouterKey = process.env.OPENROUTER_API_KEY;
const deepseekKey = process.env.DEEPSEEK_API_KEY;

// ====== 工具函数 ======
function ok(data) { return { success: true, ...data }; }
function fail(error, status) { return { success: false, error }; }

// ====== 认证 API ======
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.verifyUser(username, password);
  if (user) {
    const { password: _, ...safeUser } = user;
    res.json(ok({ user: safeUser }));
  } else {
    res.status(401).json(fail('用户名或密码错误'));
  }
});

// ====== 用户 API ======
app.get('/api/users', (req, res) => {
  const users = db.getUsers().map(({ password, ...u }) => u);
  res.json(ok({ users }));
});

app.post('/api/users', (req, res) => {
  const user = db.addUser(req.body);
  res.json(ok({ user }));
});

// ====== 仪表盘 API ======
app.get('/api/dashboard', (req, res) => {
  const stats = db.getDashboardStats();
  res.json(ok({ stats }));
});

// ====== 季度企划 API ======
app.get('/api/plans', (req, res) => {
  const plans = db.getSeasonalPlans(req.query);
  res.json(ok({ plans }));
});

app.get('/api/plans/:planId', (req, res) => {
  const plan = db.getSeasonalPlan(req.params.planId);
  if (!plan) return res.status(404).json(fail('企划不存在'));
  const slots = db.getLinePlanSlots(req.params.planId);
  res.json(ok({ plan, slots }));
});

app.post('/api/plans', (req, res) => {
  const plan = db.createSeasonalPlan(req.body);
  res.json(ok({ plan }));
});

app.put('/api/plans/:planId', (req, res) => {
  const plan = db.updateSeasonalPlan(req.params.planId, req.body);
  if (!plan) return res.status(404).json(fail('企划不存在'));
  res.json(ok({ plan }));
});

// ====== Line Plan 槽位 API ======
app.get('/api/plans/:planId/slots', (req, res) => {
  const slots = db.getLinePlanSlots(req.params.planId);
  res.json(ok({ slots }));
});

app.post('/api/plans/:planId/slots', (req, res) => {
  const slot = db.createLinePlanSlot({ ...req.body, plan_id: req.params.planId });
  res.json(ok({ slot }));
});

app.put('/api/slots/:slotId', (req, res) => {
  const slot = db.updateLinePlanSlot(req.params.slotId, req.body);
  if (!slot) return res.status(404).json(fail('槽位不存在'));
  res.json(ok({ slot }));
});

app.delete('/api/slots/:slotId', (req, res) => {
  db.deleteLinePlanSlot(req.params.slotId);
  res.json(ok({ deleted: true }));
});

// ====== 款式管理 API ======
app.get('/api/styles', (req, res) => {
  const styles = db.getStyles(req.query);
  res.json(ok({ styles }));
});

app.get('/api/styles/:styleId', (req, res) => {
  const style = db.getStyle(req.params.styleId);
  if (!style) return res.status(404).json(fail('款式不存在'));
  const samples = db.getSamples({ style_id: req.params.styleId });
  const research = db.getSorftimeResearch({ concept_id: req.params.styleId });
  res.json(ok({ style, samples, research }));
});

app.post('/api/styles', (req, res) => {
  const style = db.createStyle(req.body);
  res.json(ok({ style }));
});

app.put('/api/styles/:styleId', (req, res) => {
  const style = db.updateStyle(req.params.styleId, req.body);
  if (!style) return res.status(404).json(fail('款式不存在'));
  res.json(ok({ style }));
});

app.put('/api/styles/:styleId/status', (req, res) => {
  const result = db.transitionStyleStatus(req.params.styleId, req.body.status);
  if (result.error) return res.status(400).json(fail(result.error));
  res.json(ok({ style: result }));
});

app.delete('/api/styles/:styleId', (req, res) => {
  db.deleteStyle(req.params.styleId);
  res.json(ok({ deleted: true }));
});

// 开发看板 — 按状态分组
app.get('/api/kanban', (req, res) => {
  const allStyles = db.getStyles(req.query);
  const columns = {};
  db.STYLE_STATUSES.forEach(s => columns[s] = []);
  allStyles.forEach(s => { if (columns[s.status]) columns[s.status].push(s); });
  res.json(ok({ columns, flow: db.STATUS_FLOW }));
});

// ====== 样品追踪 API ======
app.get('/api/samples', (req, res) => {
  const samples = db.getSamples(req.query);
  res.json(ok({ samples }));
});

app.get('/api/samples/:sampleId', (req, res) => {
  const sample = db.getSample(req.params.sampleId);
  if (!sample) return res.status(404).json(fail('样品不存在'));
  res.json(ok({ sample }));
});

app.post('/api/samples', (req, res) => {
  const sample = db.createSample(req.body);
  res.json(ok({ sample }));
});

app.put('/api/samples/:sampleId', (req, res) => {
  const sample = db.updateSample(req.params.sampleId, req.body);
  if (!sample) return res.status(404).json(fail('样品不存在'));
  res.json(ok({ sample }));
});

app.post('/api/samples/:sampleId/review', (req, res) => {
  const { result, reviewer, comments } = req.body;
  const sample = db.reviewSample(req.params.sampleId, result, reviewer, comments);
  if (!sample) return res.status(404).json(fail('样品不存在'));
  // 自动创建下一轮打样（如果被打回）
  if (result === 'Fail') {
    const nextSample = db.createSample({
      style_id: sample.style_id,
      round: sample.round === 'Proto' ? 'Revision' : sample.round,
      round_number: (sample.round_number || 1) + 1,
      supplier_id: sample.supplier_id,
      comments: `上一轮修改要求: ${comments}`,
    });
    return res.json(ok({ sample, next_sample: nextSample }));
  }
  res.json(ok({ sample }));
});

// ====== 供应商 API ======
app.get('/api/suppliers', (req, res) => {
  res.json(ok({ suppliers: db.getSuppliers() }));
});

app.post('/api/suppliers', (req, res) => {
  const supplier = db.createSupplier(req.body);
  res.json(ok({ supplier }));
});

// ====== Sorftime 调研 API ======
app.get('/api/research', (req, res) => {
  const research = db.getSorftimeResearch(req.query);
  res.json(ok({ research }));
});

// 概念评分
app.post('/api/research/score', (req, res) => {
  const score = db.calculateConceptScore(req.body);
  res.json(ok({ score }));
});

// ====== 对话历史 API ======
app.get('/api/chat/sessions/:userId', (req, res) => {
  const sessions = db.getChatSessions(req.params.userId);
  res.json(ok({ sessions }));
});

app.get('/api/chat/history/:userId/:sessionId', (req, res) => {
  const history = db.getChatHistory(req.params.userId, req.params.sessionId);
  res.json(ok({ history }));
});

// ====== 产品查询历史 ======
app.get('/api/products/:userId', (req, res) => {
  const queries = db.getProductQueries(req.params.userId);
  res.json(ok({ queries }));
});

// ====== 带超时的 fetch（Node.js 18 内置 fetch 不支持 timeout 参数）======
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally { clearTimeout(timer); }
}

// ====== Sorftime MCP 核心调用 ======
async function callMCPTool(key, toolName, args) {
  
  const mcpUrl = `https://mcp.sorftime.com?key=${key}`;

  // 先尝试直接调用
  try {
    const resp = await fetchWithTimeout(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      }),
    }, 30000);
    const data = await resp.json();
    if (data.result) return data.result;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  } catch (e) {
    // 尝试初始化握手
    try {
      const initResp = await fetchWithTimeout(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'FashionPilot', version: '2.0' } } }),
      }, 15000);
      const sessionId = initResp.headers.get('mcp-session-id');
      const headers = { 'Content-Type': 'application/json' };
      if (sessionId) headers['mcp-session-id'] = sessionId;

      // 发送 initialized 通知
      await fetchWithTimeout(mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }, 10000);

      // 调用工具
      const toolResp = await fetchWithTimeout(mcpUrl, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } }),
      }, 30000);
      const toolData = await toolResp.json();
      if (toolData.result) return toolData.result;
      throw new Error(toolData.error?.message || 'MCP 调用失败');
    } catch (e2) {
      throw new Error(`MCP 调用失败: ${e2.message}`);
    }
  }
}

// ====== 主 API 端点 (/api/sorftime) ======
app.post('/api/sorftime', async (req, res) => {
  const { action, params = {} } = req.body;

  try {
    switch (action) {
      case 'health': {
        res.json(ok({
          keys: { sorftime: !!mcpKey, openrouter: !!openrouterKey, deepseek: !!deepseekKey },
          server: 'aliyun-ecs', version: '2.0',
        }));
        break;
      }

      case 'mcp_test': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const result = await callMCPTool(mcpKey, 'list_tools', {});
        res.json(ok({ tools: result }));
        break;
      }

      case 'mcp_tools_list': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const result = await callMCPTool(mcpKey, 'list_tools', {});
        res.json(ok({ tools: result }));
        break;
      }

      case 'product_detail': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const { asin, site = 'US' } = params;
        if (!asin) return res.json(fail('缺少 ASIN'));
        const result = await callMCPTool(mcpKey, 'product_detail', { amzSite: site, asin });
        const dataStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        // 存储查询记录
        db.saveProductQuery(params.userId || 'system', asin, site, dataStr.substring(0, 5000));
        res.json(ok({ data: dataStr }));
        break;
      }

      case 'category_top': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const { nodeId, site = 'US' } = params;
        if (!nodeId) return res.json(fail('缺少 nodeId'));
        const result = await callMCPTool(mcpKey, 'bsr_top100', { amzSite: site, nodeId });
        res.json(ok({ data: result }));
        break;
      }

      case 'product_history': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const { asin, site = 'US', startDate, endDate } = params;
        if (!asin) return res.json(fail('缺少 ASIN'));
        const toolArgs = { amzSite: site, asin };
        if (startDate) toolArgs.startDate = startDate;
        if (endDate) toolArgs.endDate = endDate;
        try {
          const result = await callMCPTool(mcpKey, 'product_history_trend', toolArgs);
          res.json(ok({ data: result }));
        } catch(e) {
          // Fallback to product_detail if history not available
          const result = await callMCPTool(mcpKey, 'product_detail', { amzSite: site, asin });
          res.json(ok({ data: result, note: 'history_fallback' }));
        }
        break;
      }

      case 'market_report': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const { nodeId, site = 'US' } = params;
        if (!nodeId) return res.json(fail('缺少 nodeId'));
        const result = await callMCPTool(mcpKey, 'market_analysis', { amzSite: site, nodeId });
        // 保存调研数据
        if (result && typeof result === 'object') {
          db.saveSorftimeResearch({
            slot_id: params.slot_id || '',
            keyword: params.keyword || nodeId,
            raw_data: result,
          });
        }
        res.json(ok({ data: result }));
        break;
      }

      case 'mcp_call': {
        if (!mcpKey) return res.json(fail('Sorftime Key 未配置'));
        const { tool, args } = params;
        if (!tool) return res.json(fail('缺少工具名'));
        const result = await callMCPTool(mcpKey, tool, args || {});
        res.json(ok({ data: result }));
        break;
      }

      case 'ai_chat': {
        const { message, model = 'claude', userId, sessionId } = params;
        if (!message) return res.json(fail('缺少消息'));

        const systemPrompt = `你是FashionPilot亚马逊服装智能选品系统的AI助手。你精通亚马逊服装类目运营、选品策略、市场分析、产品开发管理。
公司情况：20人团队，年销量50万件，女装裤子为主，3人开发团队，年开发约100款。
请基于提供的真实数据进行专业分析。回复使用中文，重点数据用**加粗**标注。
分析时关注：销量趋势、价格策略、评论特征、竞争格局、选品建议、开发流程优化。`;

        let reply = '', usedModel = model;

        if (model === 'deepseek' && deepseekKey) {
          
          const r = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }], temperature: 0.7, max_tokens: 4096 }),
          }, 60000);
          const data = await r.json();
          reply = data.choices?.[0]?.message?.content || 'AI 无响应';
          usedModel = 'DeepSeek';
        } else if (openrouterKey) {
          
          const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openrouterKey}` },
            body: JSON.stringify({ model: 'anthropic/claude-sonnet-4', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }], temperature: 0.7, max_tokens: 4096 }),
          }, 60000);
          const data = await r.json();
          reply = data.choices?.[0]?.message?.content || 'AI 无响应';
          usedModel = 'Claude';
        } else {
          return res.json(fail('AI Key 未配置'));
        }

        // 保存对话
        const sid = sessionId || db.uuid();
        db.saveChatMessage(userId || 'anonymous', sid, 'user', message, usedModel);
        db.saveChatMessage(userId || 'anonymous', sid, 'assistant', reply, usedModel);

        res.json(ok({ reply, model: usedModel, sessionId: sid }));
        break;
      }

      case 'ai_analyze': {
        const { asin, site = 'US', model = 'claude', question } = params;
        if (!asin) return res.json(fail('缺少 ASIN'));

        // 先获取产品数据
        let productData = '';
        if (mcpKey) {
          try {
            const result = await callMCPTool(mcpKey, 'product_detail', { amzSite: site, asin });
            productData = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          } catch (e) { productData = `无法获取产品数据: ${e.message}`; }
        }

        const analysisPrompt = `以下是亚马逊产品 ${asin} 的 Sorftime 数据：\n${productData.substring(0, 8000)}\n\n请分析: ${question || '从选品角度全面分析这个产品'}`;

        // 复用 ai_chat 逻辑
        const chatParams = { message: analysisPrompt, model, userId: params.userId };
        req.body.params = chatParams;
        req.body.action = 'ai_chat';
        // 递归调用
        const systemPrompt = `你是FashionPilot的选品分析专家。基于Sorftime真实数据进行深度分析。回复中文，用**加粗**标注关键数据。`;

        let reply = '', usedModel = model;
        

        if (model === 'deepseek' && deepseekKey) {
          const r = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: analysisPrompt }], temperature: 0.7, max_tokens: 4096 }),
          }, 60000);
          const data = await r.json();
          reply = data.choices?.[0]?.message?.content || 'AI 无响应';
          usedModel = 'DeepSeek';
        } else if (openrouterKey) {
          const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openrouterKey}` },
            body: JSON.stringify({ model: 'anthropic/claude-sonnet-4', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: analysisPrompt }], temperature: 0.7, max_tokens: 4096 }),
          }, 60000);
          const data = await r.json();
          reply = data.choices?.[0]?.message?.content || 'AI 无响应';
          usedModel = 'Claude';
        } else {
          return res.json(fail('AI Key 未配置'));
        }

        res.json(ok({ reply, model: usedModel, productData: productData.substring(0, 2000) }));
        break;
      }

      default:
        res.status(400).json(fail(`未知 action: ${action}`));
    }
  } catch (e) {
    console.error(`[API Error] ${action}:`, e.message);
    res.status(500).json(fail(e.message));
  }
});

// ====== 启动服务 ======
app.listen(PORT, () => {
  console.log(`\n  🚀 FashionPilot v2.0 启动成功`);
  console.log(`  📍 地址: http://localhost:${PORT}`);
  console.log(`  📊 API Keys:`);
  console.log(`     Sorftime: ${mcpKey ? '✅' : '❌'}`);
  console.log(`     OpenRouter: ${openrouterKey ? '✅' : '❌'}`);
  console.log(`     DeepSeek: ${deepseekKey ? '✅' : '❌'}`);
  console.log(`  💾 数据库: ${path.resolve(path.join(__dirname, 'data', 'db.json'))}\n`);
});
