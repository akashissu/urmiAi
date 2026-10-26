import { pool } from "../db/pool.js";
import { getClient, evictClient, withTimeout } from "./upstreamPool.js";
import { config } from "../config.js";
import type { ServerRow } from "./types.js";

let timer: NodeJS.Timeout | null = null;

/**
 * Pings every enabled upstream on a fixed interval and records the result
 * in mcp_servers.status. This is what drives the dashboard's
 * Connected / Unreachable badge — it is deliberately separate from the
 * request path so a dashboard page load never has to wait on upstreams.
 */
export function startHealthLoop(): void {
  timer = setInterval(() => {
    checkAll().catch((err) => console.error("health loop error", err));
  }, config.healthCheckIntervalMs);
  timer.unref();
}

export function stopHealthLoop(): void {
  if (timer) clearInterval(timer);
}

async function checkAll(): Promise<void> {
  const { rows } = await pool.query<ServerRow>(`SELECT * FROM mcp_servers WHERE enabled = true`);
  await Promise.allSettled(rows.map(checkOne));
}

async function checkOne(server: ServerRow): Promise<void> {
  let status: "connected" | "unreachable" = "connected";
  try {
    const client = await getClient(server);
    await withTimeout(client.listTools(), config.upstreamTimeoutMs, server.slug);
  } catch {
    status = "unreachable";
    evictClient(server.id);
  }
  await pool.query(`UPDATE mcp_servers SET status = $1, last_checked_at = now() WHERE id = $2`, [status, server.id]);
}
