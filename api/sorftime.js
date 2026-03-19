// Vercel Serverless Function: /api/sorftime.js
// MCP streamableHttp client for Sorftime data collection

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
        if (Array.isArray(parsed)) {
          messages.push(...parsed);
        } else {
          messages.push(parsed);
        }
      } catch (e) { /* skip non-JSON */ }
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
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      throw new Error(`MCP请求超时(50s) - method: ${body.method}`);
    }
    throw new Error(`MCP网络错误: ${e.message}`);
  }
  clearTimeout(timeout);

  const newSession = resp.headers.get("mcp-session-id") || sessionId;
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const raw = await resp.text();

  // Notifications return 202 with no body
  if (resp.status === 202 || !raw.trim()) {
    return { data: null, sessionId: newSession, ok: true };
  }

  // Non-OK status — return detailed error
  if (!resp.ok) {
    return {
      data: null,
      sessionId: newSession,
      ok: false,
      error: `HTTP ${resp.status}: ${raw.substring(0, 500)}`
    };
  }

  let result = null;

  if (ct.includes("text/event-stream")) {
    const msgs = parseSSEMessages(raw);
    for (const m of msgs) {
      if (m.id === body.id) { result = m; break; }
      if (m.result !== undefined || m.error !== undefined) result = m;
    }
    if (!result && msgs.length > 0) result = msgs[msgs.length - 1];
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        result = parsed.find(m => m.id === body.id) || parsed[parsed.length - 1];
      } else {
        result = parsed;
      }
    } catch (e) {
      return { data: null, sessionId: newSession, ok: false, error: `JSON解析失败(${resp.status}): ${raw.substring(0, 300)}` };
    }
  }

  return { data: result, sessionId: newSession, ok: resp.ok };
}

// ─── MCP tool call - try direct first, fallback to full handshake ─
async function callMCPTool(mcpKey, toolName, toolArgs) {
  const mcpUrl = `https://mcp.sorftime.com?key=${mcpKey}`;

  // Try direct tool call first (skip handshake - faster)
  try {
    const direct = await mcpPost(mcpUrl, {
      jsonrpc: "2.0",
      id: "tool-1",
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs }
    }, null);

    if (direct.ok && direct.data && !direct.data.error) {
      return direct.data?.result || direct.data;
    }
    // Direct call got a response but with error — log it
    if (direct.data?.error) {
      console.log(`Direct call error for ${toolName}:`, JSON.stringify(direct.data.error));
    }
    if (direct.error) {
      console.log(`Direct call HTTP error for ${toolName}:`, direct.error);
    }
  } catch (e) {
    console.log(`Direct call exception for ${toolName}:`, e.message);
  }

  // Fallback: full handshake — try both protocol versions
  const protocolVersions = ["2025-03-26", "2024-11-05"];
  let lastError = null;

  for (const protoVer of protocolVersions) {
    try {
      const init = await mcpPost(mcpUrl, {
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: protoVer,
          capabilities: {},
          clientInfo: { name: "amazon-ops-hub", version: "7.0.0" }
        }
      }, null);

      if (!init.ok || !init.sessionId) {
        lastError = `Initialize失败(proto=${protoVer}): ${init.error || "无sessionId"}`;
        continue;
      }

      const sid = init.sessionId;

      await mcpPost(mcpUrl, {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }, sid);

      const tool = await mcpPost(mcpUrl, {
        jsonrpc: "2.0",
        id: "tool-1",
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs }
      }, sid);

      if (tool.data?.error) {
        lastError = `Tool error(proto=${protoVer}): ${JSON.stringify(tool.data.error)}`;
        continue;
      }

      return tool.data?.result || tool.data;
    } catch (e) {
      lastError = `Handshake exception(proto=${protoVer}): ${e.message}`;
      continue;
    }
  }

  throw new Error(lastError || "MCP所有协议版本均失败");
}

// ─── Extract text from MCP tool result ──────────────────────────
function extractText(result) {
  if (!result) return null;
  if (result.content && Array.isArray(result.content)) {
    return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// ─── AI call via OpenRouter (Claude Sonnet) ────────────────────
async function callDeepSeek(key, prompt) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      messages: [
        { role: "system", content: "你是专业的亚马逊Listing文案专家，精通A9和COSMO算法。请基于提供的真实数据进行分析。中文回复分析，英文写Listing文案。所有表格使用Markdown格式。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 8192
    })
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || "无返回内容";
}

// ─── Main Handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { action, params, mcpKey, deepseekKey } = req.body;

    // ── mcp_test: Debug endpoint to test MCP connection ──
    if (action === "mcp_test") {
      if (!mcpKey) return res.status(400).json({ error: "Missing MCP key" });
      const mcpUrl = `https://mcp.sorftime.com?key=${mcpKey}`;
      const results = {};

      // Test 1: Raw initialize with current protocol
      for (const protoVer of ["2025-03-26", "2024-11-05"]) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const resp = await fetch(mcpUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "test-1",
              method: "initialize",
              params: {
                protocolVersion: protoVer,
                capabilities: {},
                clientInfo: { name: "ops-hub-diag", version: "7.0.0" }
              }
            }),
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const ct = resp.headers.get("content-type");
          const sid = resp.headers.get("mcp-session-id");
          const raw = await resp.text();

          results[`proto_${protoVer}`] = {
            status: resp.status,
            ok: resp.ok,
            contentType: ct,
            sessionId: sid ? sid.substring(0, 20) + "..." : null,
            bodyPreview: raw.substring(0, 300),
            bodyLength: raw.length,
          };
        } catch (e) {
          results[`proto_${protoVer}`] = {
            error: e.name === "AbortError" ? "超时(15s)" : e.message
          };
        }
      }

      // Test 2: Direct tool call (no handshake)
      try {
        const direct = await mcpPost(mcpUrl, {
          jsonrpc: "2.0",
          id: "diag-1",
          method: "tools/call",
          params: { name: "product_detail", arguments: { amzSite: "US", asin: "B0CHX3PNKW" } }
        }, null);
        results.direct_tool_call = {
          ok: direct.ok,
          hasData: !!direct.data,
          hasError: !!direct.data?.error,
          error: direct.error || (direct.data?.error ? JSON.stringify(direct.data.error).substring(0, 200) : null),
          preview: direct.data ? JSON.stringify(direct.data).substring(0, 200) : null,
        };
      } catch (e) {
        results.direct_tool_call = { error: e.message };
      }

      return res.status(200).json({
        success: true,
        timestamp: new Date().toISOString(),
        mcpUrl: mcpUrl.replace(/key=.*/, "key=***"),
        results
      });
    }

    // ── mcp_tools_list: List all available tools + schemas ──
    if (action === "mcp_tools_list") {
      if (!mcpKey) return res.status(400).json({ error: "Missing MCP key" });
      const mcpUrl = `https://mcp.sorftime.com?key=${mcpKey}`;

      // Initialize with 2025-03-26 protocol (confirmed working)
      const init = await mcpPost(mcpUrl, {
        jsonrpc: "2.0", id: "init-tl", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ops-hub-diag", version: "7.0.0" } }
      }, null);

      const sid = init.sessionId;
      await mcpPost(mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);

      // List tools
      const toolsResp = await mcpPost(mcpUrl, {
        jsonrpc: "2.0", id: "tl-1", method: "tools/list", params: {}
      }, sid);

      const toolList = toolsResp.data?.result?.tools || [];
      const tools = toolList.map(t => ({
        name: t.name,
        description: (t.description || "").substring(0, 150),
        params: Object.keys(t.inputSchema?.properties || {}),
        required: t.inputSchema?.required || [],
        fullSchema: t.inputSchema,
      }));

      // Also try a real ASIN test via the handshake session
      let testResult = null;
      const pdTool = toolList.find(t => t.name === "product_detail");
      if (pdTool && params?.testAsin) {
        const testCall = await mcpPost(mcpUrl, {
          jsonrpc: "2.0", id: "test-real", method: "tools/call",
          params: { name: "product_detail", arguments: { amzSite: params.testSite || "US", asin: params.testAsin } }
        }, sid);
        testResult = {
          raw: JSON.stringify(testCall.data).substring(0, 500),
          text: extractText(testCall.data?.result || testCall.data),
        };
      }

      return res.status(200).json({ success: true, tools, testResult });
    }

    // ── fetch_data: Real Sorftime data for ASINs ──
    if (action === "fetch_data") {
      if (!mcpKey) return res.status(400).json({ error: "Missing Sorftime MCP key" });
      const { asins } = params;
      const results = [];
      const errors = [];

      for (const comp of asins) {
        const siteMap = { US:"US", UK:"GB", GB:"GB", DE:"DE", FR:"FR", JP:"JP", CA:"CA", ES:"ES", IT:"IT", MX:"MX", IN:"IN", AU:"AU" };
        const amzSite = siteMap[comp.site] || comp.site;
        const item = { asin: comp.asin, site: comp.site, detail: null };

        try {
          const r = await callMCPTool(mcpKey, "product_detail", { amzSite, asin: comp.asin });
          item.detail = extractText(r);
        } catch (e) { errors.push(`detail(${comp.asin}): ${e.message}`); }

        results.push(item);
      }

      return res.status(200).json({
        success: true,
        data: results,
        errors: errors.length ? errors : undefined,
        source: results.some(r => r.detail) ? "sorftime" : "failed"
      });
    }

    // ── AI-only actions ──
    if (["voc_analysis", "listing_analysis", "generate_listing", "compliance_check"].includes(action)) {
      if (!deepseekKey) return res.status(400).json({ error: "Missing DeepSeek key" });
      const result = await callDeepSeek(deepseekKey, params.prompt);
      return res.status(200).json({ success: true, result });
    }

    // ── Direct MCP tool call ──
    if (action === "mcp_call") {
      if (!mcpKey) return res.status(400).json({ error: "Missing MCP key" });
      const result = await callMCPTool(mcpKey, params.tool, params.args);
      return res.status(200).json({ success: true, result: extractText(result) });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({
      error: error.message || "Internal server error",
      hint: error.message?.includes("超时") ? "Sorftime服务响应超时，可能服务暂时不可用" :
            error.message?.includes("网络") ? "无法连接到Sorftime服务器" :
            error.message?.includes("协议") ? "MCP协议版本可能已更新，请联系Sorftime确认" : undefined
    });
  }
}
