import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { apiRouter } from "./routes/api.js";
import { requireApiKey, type AuthedRequest } from "./auth/middleware.js";
import { listAggregatedTools, callAggregatedTool, writeAuditLog } from "./mcp/aggregator.js";
import { startHealthLoop } from "./mcp/healthLoop.js";
import type { CallOutcome } from "./mcp/types.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/livez", (_req, res) => res.json({ ok: true }));

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, reason: "database unreachable" });
  }
});

app.use("/api", apiRouter);

/**
 * The gateway's own MCP endpoint. Every session builds its tool list from
 * the aggregator at request time, so disabling an upstream or one going
 * unreachable takes effect on the very next request without reconnecting.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", requireApiKey, async (req: AuthedRequest, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    const server = buildGatewayServer(req.apiKeyUserId!);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireApiKey, async (req, res) => {
  const transport = transports.get(req.header("mcp-session-id") ?? "");
  if (!transport) return res.status(400).json({ error: "Unknown or missing mcp-session-id" });
  await transport.handleRequest(req, res);
});

/**
 * registerTool() installs the SDK's tools/list and tools/call handlers, which
 * only know about tools registered up front. Our set changes whenever an
 * admin enables or disables a server, so both handlers are replaced:
 * list reads the aggregator on every request, and call routes by the
 * "<slug>__<tool>" prefix instead of a static map.
 */
function buildGatewayServer(userId: string): McpServer {
  const server = new McpServer({ name: "urmiai-gateway", version: "0.1.0" });

  server.registerTool(
    "gateway_status",
    { description: "Lists how many upstream tools are currently enabled.", inputSchema: {} },
    async () => executeToolCall(userId, "gateway_status", {}),
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await listAggregatedTools();
    return {
      tools: [
        { name: "gateway_status", description: "Lists how many upstream tools are currently enabled.", inputSchema: { type: "object", properties: {} } },
        ...tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      ],
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return executeToolCall(userId, request.params.name, request.params.arguments ?? {});
  });

  return server;
}

async function executeToolCall(userId: string, toolName: string, args: Record<string, unknown>) {
  if (toolName === "gateway_status") {
    const { tools, failures } = await listAggregatedTools();
    return { content: [{ type: "text" as const, text: JSON.stringify({ toolCount: tools.length, failures }) }] };
  }

  const startedAt = new Date();
  const { serverSlug, outcome } = await callAggregatedTool(toolName, args ?? {});
  await writeAuditLog({
    userId,
    serverSlug,
    toolName,
    startedAt,
    durationMs: outcome.durationMs,
    success: outcome.ok,
    errorMessage: outcome.ok ? null : outcome.message,
  });
  return outcomeToMcpResult(outcome);
}

function outcomeToMcpResult(outcome: CallOutcome): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (outcome.ok) {
    return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Tool call failed (${outcome.reason}): ${outcome.message}` }],
  };
}

app.listen(config.port, () => {
  console.log(`gateway listening on :${config.port}`);
  startHealthLoop();
});
