import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";
import { decryptCredential } from "../crypto/credentials.js";
import type { ServerRow } from "./types.js";

interface PooledClient {
  client: Client;
  /** Changes whenever the server's URL or credential changes, forcing a reconnect. */
  fingerprint: string;
}

const pool = new Map<string, PooledClient>();

/**
 * One persistent MCP client per upstream server, reused across requests.
 * Rebuilt lazily if the server's URL or credential changed since the
 * client was created.
 */
export async function getClient(server: ServerRow): Promise<Client> {
  const fingerprint = `${server.base_url}|${server.auth_type}|${server.credential_auth_tag?.toString("hex") ?? ""}`;
  const existing = pool.get(server.id);
  if (existing && existing.fingerprint === fingerprint) return existing.client;

  if (existing) await existing.client.close().catch(() => undefined);

  const headers: Record<string, string> = {};
  if (server.auth_type !== "none" && server.encrypted_credential && server.credential_iv && server.credential_auth_tag) {
    const credential = decryptCredential({
      ciphertext: server.encrypted_credential,
      iv: server.credential_iv,
      authTag: server.credential_auth_tag,
    });
    if (server.auth_type === "bearer") headers.authorization = `Bearer ${credential}`;
    if (server.auth_type === "header" && server.auth_header_name) headers[server.auth_header_name] = credential;
  }

  const client = new Client({ name: "urmiai-gateway", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.base_url), { requestInit: { headers } });
  await withTimeout(client.connect(transport), config.upstreamTimeoutMs, server.slug);
  pool.set(server.id, { client, fingerprint });
  return client;
}

/** Drops a client so the next call reconnects. Used when a call fails. */
export function evictClient(serverId: string): void {
  const existing = pool.get(serverId);
  pool.delete(serverId);
  existing?.client.close().catch(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, ms: number, serverSlug: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Upstream ${serverSlug} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export { withTimeout };
