import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { signSession } from "../auth/jwt.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../auth/apiKeys.js";
import { requireUser, requireAdmin, type AuthedRequest } from "../auth/middleware.js";
import { encryptCredential } from "../crypto/credentials.js";
import { assertUrlAllowed } from "../mcp/ssrfGuard.js";
import { listAggregatedTools, callAggregatedTool, writeAuditLog } from "../mcp/aggregator.js";
import { getClient, withTimeout } from "../mcp/upstreamPool.js";
import { runChatTurn, type ChatMessage } from "../chat/agent.js";
import { config } from "../config.js";
import type { ServerRow } from "../mcp/types.js";

export const apiRouter = Router();

const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

// --- Auth ---

apiRouter.post("/auth/register", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { rows: existing } = await pool.query(`SELECT count(*)::int AS n FROM users`);
  const role = existing[0].n === 0 ? "admin" : "member";

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
      [parsed.data.email, await hashPassword(parsed.data.password), role],
    );
    const user = rows[0];
    // Every user gets a gateway API key at registration. The raw value is
    // discarded. Chat does not present this key: the dashboard JWT identifies
    // the user, and runChatTurn calls tools in-process under that user id.
    await issueApiKey(user.id, "chat-agent", true);
    return res.status(201).json({ token: signSession({ sub: user.id, email: user.email, role: user.role }), user });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "Email already registered" });
    throw err;
  }
});

apiRouter.post("/auth/login", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { rows } = await pool.query(`SELECT id, email, role, password_hash FROM users WHERE email = $1`, [parsed.data.email]);
  const user = rows[0];
  if (!user || !(await verifyPassword(user.password_hash, parsed.data.password))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  return res.json({ token: signSession({ sub: user.id, email: user.email, role: user.role }), user: { id: user.id, email: user.email, role: user.role } });
});

apiRouter.get("/auth/me", requireUser, (req: AuthedRequest, res) => {
  res.json({ id: req.user!.sub, email: req.user!.email, role: req.user!.role });
});

// --- API keys ---

apiRouter.get("/keys", requireUser, async (req: AuthedRequest, res) => {
  res.json(await listApiKeys(req.user!.sub));
});

apiRouter.post("/keys", requireUser, async (req: AuthedRequest, res) => {
  const parsed = z.object({ label: z.string().min(1).max(60).default("default") }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { record, rawKey } = await issueApiKey(req.user!.sub, parsed.data.label);
  // rawKey is returned exactly once, here. It is never stored or retrievable again.
  res.status(201).json({ ...record, rawKey });
});

apiRouter.post("/keys/:id/revoke", requireUser, async (req: AuthedRequest, res) => {
  const revoked = await revokeApiKey(req.params.id, req.user!.sub);
  if (!revoked) return res.status(404).json({ error: "Key not found or already revoked" });
  res.json({ revoked: true });
});

// --- MCP servers ---

const serverInput = z.object({
  slug: z.string().regex(SLUG_PATTERN, "slug must be 2-40 chars, lowercase letters, digits and hyphens"),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  authType: z.enum(["none", "header", "bearer"]).default("none"),
  authHeaderName: z.string().optional(),
  credential: z.string().optional(),
});

apiRouter.get("/servers", requireUser, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, slug, name, base_url, auth_type, enabled, status, last_checked_at, created_at FROM mcp_servers ORDER BY created_at`,
  );
  res.json(rows);
});

apiRouter.post("/servers", requireUser, requireAdmin, async (req, res) => {
  const parsed = serverInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    await assertUrlAllowed(parsed.data.baseUrl);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  const encrypted = parsed.data.credential ? encryptCredential(parsed.data.credential) : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mcp_servers (slug, name, base_url, auth_type, auth_header_name, encrypted_credential, credential_iv, credential_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, slug, name, base_url, auth_type, enabled, status`,
      [
        parsed.data.slug,
        parsed.data.name,
        parsed.data.baseUrl,
        parsed.data.authType,
        parsed.data.authHeaderName ?? null,
        encrypted?.ciphertext ?? null,
        encrypted?.iv ?? null,
        encrypted?.authTag ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `A server with slug ${parsed.data.slug} is already registered` });
    throw err;
  }
});

apiRouter.post("/servers/:id/disable", requireUser, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE mcp_servers SET enabled = false WHERE id = $1 RETURNING id, slug, enabled`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Server not found" });
  res.json(rows[0]);
});

apiRouter.post("/servers/:id/enable", requireUser, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`UPDATE mcp_servers SET enabled = true WHERE id = $1 RETURNING id, slug, enabled`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Server not found" });
  res.json(rows[0]);
});

apiRouter.delete("/servers/:id", requireUser, requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Server not found" });
  res.status(204).end();
});

apiRouter.get("/servers/:id/tools", requireUser, async (req, res) => {
  const { rows } = await pool.query<ServerRow>(`SELECT * FROM mcp_servers WHERE id = $1`, [req.params.id]);
  const server = rows[0];
  if (!server) return res.status(404).json({ error: "Server not found" });
  try {
    const client = await getClient(server);
    const listed = await withTimeout(client.listTools(), config.upstreamTimeoutMs, server.slug);
    res.json(listed.tools);
  } catch (err) {
    res.status(502).json({ error: `Server ${server.slug} is unreachable: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// --- Audit log ---

apiRouter.get("/audit", requireUser, async (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  // Members only ever see their own calls. Admins see everyone's.
  const userFilter = req.user!.role === "admin" ? null : req.user!.sub;
  const { rows } = await pool.query(
    `SELECT a.id, u.email AS user_email, a.server_slug, a.tool_name, a.started_at, a.duration_ms, a.success, a.error_message
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::uuid IS NULL OR a.user_id = $1)
     ORDER BY a.created_at DESC LIMIT $2`,
    [userFilter, limit],
  );
  res.json(rows);
});

// --- Chat ---

apiRouter.post("/chat", requireUser, async (req: AuthedRequest, res) => {
  const parsed = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders();

  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await runChatTurn(req.user!.sub, parsed.data.messages as ChatMessage[], (event) => send(event.type, event.data));
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  }
  send("done", {});
  res.end();
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export { listAggregatedTools, callAggregatedTool, writeAuditLog };
