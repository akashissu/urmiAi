import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { getClient, evictClient, withTimeout } from "./upstreamPool.js";
import type { AggregatedTool, CallOutcome, ServerRow } from "./types.js";

const SEPARATOR = "__";

export async function listEnabledServers(): Promise<ServerRow[]> {
  const { rows } = await pool.query<ServerRow>(`SELECT * FROM mcp_servers WHERE enabled = true ORDER BY slug`);
  return rows;
}

/**
 * Fans out tools/list to every enabled upstream. A failed or slow upstream
 * is reported as a per-server error and simply contributes no tools —
 * it never rejects the whole call. Promise.allSettled is deliberate:
 * Promise.all would throw away every other server's tools on one failure.
 */
export async function listAggregatedTools(): Promise<{ tools: AggregatedTool[]; failures: { serverSlug: string; message: string }[] }> {
  const servers = await listEnabledServers();
  const settled = await Promise.allSettled(servers.map((server) => listToolsForServer(server)));

  const tools: AggregatedTool[] = [];
  const failures: { serverSlug: string; message: string }[] = [];
  settled.forEach((result, i) => {
    const server = servers[i];
    if (result.status === "fulfilled") {
      tools.push(...result.value);
    } else {
      failures.push({ serverSlug: server.slug, message: errorMessage(result.reason) });
      evictClient(server.id);
    }
  });
  return { tools, failures };
}

async function listToolsForServer(server: ServerRow): Promise<AggregatedTool[]> {
  const client = await getClient(server);
  const listed = await withTimeout(client.listTools(), config.upstreamTimeoutMs, server.slug);
  return listed.tools.map((tool) => ({
    name: `${server.slug}${SEPARATOR}${tool.name}`,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
    serverSlug: server.slug,
    upstreamToolName: tool.name,
  }));
}

/**
 * Routes a gateway-level tool name ("<slug>__<tool>") to the right upstream.
 * Returns a structured outcome instead of throwing, so the caller can both
 * answer the client and write the audit log from the same result.
 */
export async function callAggregatedTool(toolName: string, args: Record<string, unknown>): Promise<{ serverSlug: string; upstreamToolName: string; outcome: CallOutcome }> {
  const separatorAt = toolName.indexOf(SEPARATOR);
  if (separatorAt === -1) {
    return { serverSlug: "unknown", upstreamToolName: toolName, outcome: failure("not_found", `Tool name ${toolName} is missing the server prefix`) };
  }
  const serverSlug = toolName.slice(0, separatorAt);
  const upstreamToolName = toolName.slice(separatorAt + SEPARATOR.length);

  const { rows } = await pool.query<ServerRow>(`SELECT * FROM mcp_servers WHERE slug = $1`, [serverSlug]);
  const server = rows[0];
  if (!server) {
    return { serverSlug, upstreamToolName, outcome: failure("not_found", `No server registered with slug ${serverSlug}`) };
  }
  if (!server.enabled) {
    return { serverSlug, upstreamToolName, outcome: failure("disabled", `Server ${serverSlug} is disabled`) };
  }

  const startedAt = Date.now();
  try {
    const client = await getClient(server);
    const result = await withTimeout(client.callTool({ name: upstreamToolName, arguments: args }), config.upstreamTimeoutMs, serverSlug);
    const upstreamError = toolErrorText(result);
    if (upstreamError) {
      return {
        serverSlug,
        upstreamToolName,
        outcome: { ok: false, reason: "upstream_error", message: upstreamError, durationMs: Date.now() - startedAt },
      };
    }
    return { serverSlug, upstreamToolName, outcome: { ok: true, result, durationMs: Date.now() - startedAt } };
  } catch (err) {
    evictClient(server.id);
    const message = errorMessage(err);
    const reason = message.includes("timed out") ? "timeout" : "unreachable";
    return { serverSlug, upstreamToolName, outcome: { ok: false, reason, message, durationMs: Date.now() - startedAt } };
  }
}

export async function writeAuditLog(entry: {
  userId: string | null;
  serverSlug: string;
  toolName: string;
  startedAt: Date;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (user_id, server_slug, tool_name, started_at, duration_ms, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.userId, entry.serverSlug, entry.toolName, entry.startedAt, entry.durationMs, entry.success, entry.errorMessage],
  );
}

function failure(reason: "not_found" | "disabled", message: string): CallOutcome {
  return { ok: false, reason, message, durationMs: 0 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toolErrorText(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("isError" in result) || result.isError !== true) return null;
  const content = "content" in result ? result.content : undefined;
  if (!Array.isArray(content)) return "Upstream tool returned an error";
  const text = content
    .map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : ""))
    .filter(Boolean)
    .join("\n");
  return text || "Upstream tool returned an error";
}
