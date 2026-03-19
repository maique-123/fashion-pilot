// Vercel Serverless Function: /api/sorftime.js
// MCP streamableHttp client for Sorftime data + AI analysis

export const config = {
  maxDuration: 60,
};

// ─── Parse SSE stream text into JSON-RPC messages ───────────────
function parseSSEMessages(text) {
  const messages = [];
  const events = text.split(/\n\n|\r\n\r\n/);
  for (const event of events) {
    const lines = event.split(/\n|\r\n/);
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) continue;
      if (line.startsWith("data:")) {
        const val = line.slice(5).trimStart();
        if (val === "[DONE]") continue;
        data += val;
      }
    }
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) messages.push(...parsed);
        else messages.push(parsed);
      } catch (e) { /* skip */ }
    }
  }
  return messages;
}

// ─── Send JSON-RPC via streamableHttp POST ──────────────────────
async function mcpPost(url, body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);

  let resp;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(e.name === "AbortError" ? `MCP请求超时(50s)` : `MCP网络错误: ${e.message}`);
  }
  clearTimeout(timeout);

  const newSession = resp.headers.get("mcp-session-id") || sessionId;
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const raw = await resp.text();

  if (resp.status === 202 || !raw.trim()) return { data: null, sessionId: newSession, ok: true };
  if (!resp.ok) return { data: null, sessionId: newSession, ok: false, error: `HTTP ${resp.status}: ${raw.substring(0, 500)}` };

  let result = null;
  if (ct.includes("text/event-stream")) {
    const msgs = parseSSEMessages(raw);
    for (const m of msgs) { if (m.id === body.id) { result = m; break; } if (m.result !== undefined || m.error !== undefined) result = m; }
    if (!result && msgs.length > 0) result = msgs[msgs.length - 1];
  } else {
    try {
      const parsed = JSON.parse(raw);
      result = Array.isArray(parsed) ? (parsed.find(m => m.id === body.id) || parsed[parsed.length - 1]) : parsed;
    } catch (e) {
      return { data: null, sessionId: newSession, ok: false, error: `JSON解析失败` };
    }
  }
  return { data: result, sessionId: newSession, ok: resp.ok };
}

// ─── MCP tool call ──────────────────────────────────────────────
async function callMCPTool(mcpKey, toolName, toolArgs) {
  const mcpUrl = `https://mcp.sorftime.com?key=${mcpKey}`;

  // Try direct call first
  try {
    const direct = await mcpPost(mcpUrl, {
      jsonrpc: "2.0", id: "tool-1", method: "tools/call",
      params: { name: toolName, arguments: toolArgs }
    }, null);
    if (direct.ok && direct.data && !direct.data.error) return direct.data?.result || direct.data;
  } catch (e) { console.log(`Direct call failed: ${e.message}`); }

  // Fallback: full handshake
  for (const protoVer of ["2025-03-26", "2024-11-05"]) {
    try {
      const init = await mcpPost(mcpUrl, {
        jsonrpc: "2.0", id: "init-1", method: "initialize",
        params: { protocolVersion: protoVer, capabilities: {}, clientInfo: { name: "fashion-pilot", version: "1.0.0" } }
      }, null);
      if (!init.ok || !init.sessionId) continue;
      const sid = init.sessionId;
      await mcpPost(mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      const tool = await mcpPost(mcpUrl, {
        jsonrpc: "2.0", id: "tool-1", method: "tools/call",
        params: { name: toolName, arguments: toolArgs }
      }, sid);
      if (tool.data?.error) continue;
      return tool.data?.result || tool.data;
    } catch (e) { continue; }
  }
  throw new Error("MCP连接失败，请稍后重试");
}

// ─── Extract text from MCP result ───────────────────────────────
function extractText(result) {
  if (!result) return null;
  if (result.content && Array.isArray(result.content))
    return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// ─── AI call: Claude via OpenRouter ─────────────────────────────
async function callClaude(apiKey, systemPrompt, userPrompt) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7, max_tokens: 4096
    })
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || "AI 无返回内容";
}

// ─── AI call: DeepSeek ──────────────────────────────────────────
async function callDeepSeek(apiKey, systemPrompt, userPrompt) {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7, max_tokens: 4096
    })
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || "AI 无返回内容";
}

// ─── System prompt for AI ───────────────────────────────────────
const SYSTEM_PROMPT = `你是FashionPilot亚马逊服装智能选品系统的AI助手。你精通亚马逊服装类目运营、选品策略、市场分析。
请基于提供的真实数据进行专业分析。回复使用中文，重点数据用**加粗**标注。
分析时关注：销量趋势、价格策略、评论特征、竞争格局、选品建议。`;

// ─── Main Handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Read keys from environment variables
  const mcpKey = process.env.SORFTIME_MCP_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  try {
    const { action, params } = req.body;

    // ── Test MCP connection ──
    if (action === "mcp_test") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      try {
        const result = await callMCPTool(mcpKey, "product_detail", { amzSite: "US", asin: "B0CHX3PNKW" });
        const text = extractText(result);
        return res.status(200).json({ success: true, preview: text ? text.substring(0, 500) : "连接成功但无数据" });
      } catch (e) {
        return res.status(200).json({ success: false, error: e.message });
      }
    }

    // ── List MCP tools ──
    if (action === "mcp_tools_list") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      const mcpUrl = `https://mcp.sorftime.com?key=${mcpKey}`;
      const init = await mcpPost(mcpUrl, {
        jsonrpc: "2.0", id: "init-tl", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fashion-pilot", version: "1.0.0" } }
      }, null);
      const sid = init.sessionId;
      await mcpPost(mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      const toolsResp = await mcpPost(mcpUrl, { jsonrpc: "2.0", id: "tl-1", method: "tools/list", params: {} }, sid);
      const toolList = toolsResp.data?.result?.tools || [];
      const tools = toolList.map(t => ({ name: t.name, description: (t.description || "").substring(0, 200), params: Object.keys(t.inputSchema?.properties || {}) }));
      return res.status(200).json({ success: true, tools });
    }

    // ── Fetch product detail ──
    if (action === "product_detail") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      const { asin, site } = params;
      const siteMap = { US:"US", UK:"GB", GB:"GB", DE:"DE", FR:"FR", JP:"JP", CA:"CA", ES:"ES", IT:"IT", MX:"MX" };
      const result = await callMCPTool(mcpKey, "product_detail", { amzSite: siteMap[site] || site || "US", asin });
      return res.status(200).json({ success: true, data: extractText(result) });
    }

    // ── Fetch BSR / category data ──
    if (action === "category_top") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      const { nodeId, site } = params;
      const siteMap = { US:"US", UK:"GB", GB:"GB", DE:"DE", FR:"FR", JP:"JP", CA:"CA" };
      const result = await callMCPTool(mcpKey, "bsr_top100", { amzSite: siteMap[site] || "US", nodeId: nodeId || "7141123011" });
      return res.status(200).json({ success: true, data: extractText(result) });
    }

    // ── Fetch market/category report ──
    if (action === "market_report") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      const { nodeId, site } = params;
      const result = await callMCPTool(mcpKey, "category_report", { amzSite: site || "US", nodeId: nodeId || "7141123011" });
      return res.status(200).json({ success: true, data: extractText(result) });
    }

    // ── AI Chat ──
    if (action === "ai_chat") {
      const { message, model, context } = params;
      const userPrompt = context ? `基于以下数据:\n${context}\n\n用户问题: ${message}` : message;

      if (model === "claude") {
        if (!openrouterKey) return res.status(500).json({ error: "OPENROUTER_API_KEY 未配置" });
        const reply = await callClaude(openrouterKey, SYSTEM_PROMPT, userPrompt);
        return res.status(200).json({ success: true, reply, model: "Claude" });
      } else {
        if (!deepseekKey) return res.status(500).json({ error: "DEEPSEEK_API_KEY 未配置" });
        const reply = await callDeepSeek(deepseekKey, SYSTEM_PROMPT, userPrompt);
        return res.status(200).json({ success: true, reply, model: "DeepSeek" });
      }
    }

    // ── AI Analysis with real data ──
    if (action === "ai_analyze") {
      const { asin, site, model, question } = params;
      let dataContext = "";

      // Fetch real data first
      if (mcpKey && asin) {
        try {
          const siteMap = { US:"US", UK:"GB", GB:"GB", DE:"DE" };
          const result = await callMCPTool(mcpKey, "product_detail", { amzSite: siteMap[site] || "US", asin });
          dataContext = extractText(result) || "";
        } catch (e) { dataContext = `[数据获取失败: ${e.message}]`; }
      }

      const userPrompt = `${question || "请分析这个产品的竞争力和选品价值"}\n\n产品数据:\n${dataContext}`;

      if (model === "claude" && openrouterKey) {
        const reply = await callClaude(openrouterKey, SYSTEM_PROMPT, userPrompt);
        return res.status(200).json({ success: true, reply, model: "Claude" });
      } else if (deepseekKey) {
        const reply = await callDeepSeek(deepseekKey, SYSTEM_PROMPT, userPrompt);
        return res.status(200).json({ success: true, reply, model: "DeepSeek" });
      } else {
        return res.status(500).json({ error: "未配置AI API Key" });
      }
    }

    // ── Direct MCP tool call ──
    if (action === "mcp_call") {
      if (!mcpKey) return res.status(500).json({ error: "SORFTIME_MCP_KEY 未配置" });
      const result = await callMCPTool(mcpKey, params.tool, params.args);
      return res.status(200).json({ success: true, result: extractText(result) });
    }

    // ── Health check ──
    if (action === "health") {
      const envKeys = Object.keys(process.env).filter(k => 
        k.includes('SORFTIME') || k.includes('OPENROUTER') || k.includes('DEEPSEEK') || k.includes('VERCEL')
      );
      return res.status(200).json({
        success: true,
        keys: {
          sorftime: !!mcpKey,
          openrouter: !!openrouterKey,
          deepseek: !!deepseekKey
        },
        debug: {
          envKeysFound: envKeys,
          nodeVersion: process.version,
          mcpKeyType: typeof mcpKey,
          mcpKeyLength: mcpKey ? mcpKey.length : 0
        }
      });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message || "服务器内部错误" });
  }
}
