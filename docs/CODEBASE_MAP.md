# Codebase Map

What every folder is for and what every function in it does. Re-read this before an interview walkthrough. When you add an exported function, add its row here in the same change.

## Top-level layout

```
UrmiAi/
  README.md                  entry point
  requirment.txt             the original assignment brief, untouched
  docs/                      design, build plan, interview prep, deploy steps
  services/                  the four applications we write
    gateway/                 MCP aggregator + REST API + chat agent
    woocommerce-mcp-server/  MCP server over the WooCommerce store
    notes-mcp-server/        second upstream, an in-memory note store
    dashboard/               React UI
  helm/urmiai/               umbrella chart; local and prod differ only by values
  deploy/                    kind config, the REST-over-HTTP snippet, and seed-demo.php
  skills/                    project conventions the agent follows
  .cursor/rules/             hard guardrails enforced while building
```

## `docs/`

| File | Purpose |
|---|---|
| `architecture.md` | Stack choices, Kubernetes layout, routing, data model, the 14-day order |
| `BUILD_PLAN.md` | Day-by-day plan with the API contracts and the secrets each day needs |
| `CODEBASE_MAP.md` | this file |
| `INTERVIEW_PREP.md` | Answers to the questions an interviewer will actually ask |
| `DEPLOY.md` | Cluster creation, image build, install, and the production command |
| `third-upstream.md` | How the third MCP server is chosen and registered |
| `system-design-tradeoffs.md` | Architecture choices, aggregation and failure handling, local vs production |
| `threat-model.md` | Shared credentials, token isolation, untrusted tool text, member vs member |

## `services/gateway/`

One process with two roles: an MCP client to every registered upstream, and an MCP server exposing their combined tools at `/mcp`.

### `src/config.ts`
| Export | Does |
|---|---|
| `config` | Reads env vars once at startup. `GATEWAY_KEK`, `JWT_SECRET`, and `DATABASE_URL` have no defaults and crash the process if missing. Checks the key is exactly 32 bytes. Unset LLM env falls back to OpenAI `gpt-4.1-mini`. |

### `src/db/`
| File | Does |
|---|---|
| `pool.ts` | The shared `pg.Pool`. |
| `schema.sql` | `users`, `api_keys`, `mcp_servers`, `audit_log`. |
| `migrate.ts` | Applies the schema. Idempotent, so it runs as an init container on every start. |

### `src/crypto/credentials.ts`
| Function | Does |
|---|---|
| `encryptCredential(plaintext)` | AES-256-GCM. Returns ciphertext, IV, and auth tag, stored as three columns. |
| `decryptCredential(encrypted)` | Reverses it. Used only when building an outbound request to an upstream. |

### `src/auth/passwords.ts`
| Function | Does |
|---|---|
| `hashPassword(password)` | argon2id hash for user passwords. |
| `verifyPassword(hash, password)` | Checks a password against its hash. |

### `src/auth/apiKeys.ts`
| Function | Does |
|---|---|
| `issueApiKey(userId, label, isPrimary)` | Generates `urmiai_<random>`, stores only the argon2 hash plus an 8-char prefix, returns the raw key once. |
| `verifyApiKey(rawKey)` | Finds candidate rows by prefix, verifies with argon2, updates `last_used_at`. |
| `listApiKeys(userId)` | Returns a user's keys without hashes. |
| `revokeApiKey(keyId, userId)` | Sets `revoked_at`. A revoked key fails verification immediately. |

### `src/auth/jwt.ts`
| Function | Does |
|---|---|
| `signSession(claims)` | Signs a 12-hour dashboard JWT. |
| `verifySession(token)` | Returns the claims or null. |

### `src/auth/middleware.ts`
| Function | Does |
|---|---|
| `requireUser` | Resolves `Authorization: Bearer <jwt>` onto `req.user`, else 401. |
| `requireAdmin` | Rejects non-admins with 403. |
| `requireApiKey` | Resolves a raw API key onto `req.apiKeyUserId`. Used only by `/mcp`. |

### `src/mcp/ssrfGuard.ts`
| Function | Does |
|---|---|
| `assertUrlAllowed(url)` | Resolves the host and rejects loopback, link-local, and `169.254.169.254`. Also rejects RFC1918 unless `ALLOW_INTERNAL_UPSTREAMS=true`. |

### `src/mcp/upstreamPool.ts`
| Function | Does |
|---|---|
| `getClient(server)` | Returns a persistent MCP client for that server, rebuilding it when the URL or credential changed. Decrypts and attaches the credential here, so it never leaves the server. |
| `evictClient(serverId)` | Drops a client after a failure so the next call reconnects. |
| `withTimeout(promise, ms, slug)` | Rejects with a message naming the server if it exceeds the deadline. |

### `src/mcp/aggregator.ts`
| Function | Does |
|---|---|
| `listEnabledServers()` | Reads enabled rows from `mcp_servers`. |
| `listAggregatedTools()` | Fans out `tools/list` with `Promise.allSettled`. Prefixes every tool `<slug>__<name>`. A failed server contributes nothing and is reported in `failures` instead of sinking the call. |
| `callAggregatedTool(toolName, args)` | Splits on the first `__`, finds the server, rejects disabled or unknown servers with a structured reason, and calls the upstream with a timeout. An upstream `isError` result is a failure too (`upstream_error`), so the audit row and the MCP client both see it as failed. |
| `writeAuditLog(entry)` | Inserts one row: user, server, tool, start time, duration, outcome. |

### `src/mcp/healthLoop.ts`
| Function | Does |
|---|---|
| `startHealthLoop()` | Every 15s, pings each enabled upstream and writes `connected` or `unreachable` to `mcp_servers.status`. This is what the dashboard badge shows. |
| `stopHealthLoop()` | Clears the timer. |

### `src/chat/agent.ts`
| Function | Does |
|---|---|
| `runChatTurn(userId, history, emit)` | Sends the conversation plus the aggregated tool list to an OpenAI-compatible endpoint, executes any requested tool through `callAggregatedTool`, writes the audit row under `userId`, and emits `tool_call`, `tool_result`, and `message` events. Echoes Gemini's `extra_content` on the next round. Caps the loop at 5 rounds. |

### `src/routes/api.ts`
The REST surface. See `docs/BUILD_PLAN.md` for the full contract. In short: `/auth` (register makes the first user an admin and issues their primary key), `/keys`, `/servers` with the SSRF check on create, `/servers/:id/tools`, `/audit` (members see only their own rows), and `/chat` as a server-sent event stream.

### `src/index.ts`
| Function | Does |
|---|---|
| `buildGatewayServer(userId)` | Builds the MCP server for one session. Registers `gateway_status` so the SDK installs its handlers, then replaces both `tools/list` and `tools/call`. List reads the aggregator on every request. Call routes through `executeToolCall` by the `<slug>__<tool>` name, so a disabled server's tools vanish without a reconnect and without a static tool map. |
| `executeToolCall(userId, name, args)` | The call path for external MCP clients: route, audit, return an MCP result or an `isError` result. |
| `outcomeToMcpResult(outcome)` | Turns the aggregator's structured outcome into the MCP content shape. |

## `services/woocommerce-mcp-server/`

Speaks MCP over Streamable HTTP. Deployed as ClusterIP with no Ingress.

### `src/woocommerceClient.ts`
| Function | Does |
|---|---|
| `constructor(config)` | axios instance pointed at `/wp-json/wc/v3`. Sends the consumer key and secret as query parameters. WooCommerce ignores HTTP Basic auth unless the request looks like HTTPS, and the WordPress Apache image drops the Authorization header. |
| `listProducts` | `GET /products` |
| `createProduct` | `POST /products` as a simple product |
| `listOrders` | `GET /orders`, newest first |
| `getOrder` | `GET /orders/:id` |
| `updateOrderStatus` | `PUT /orders/:id` |

### `src/index.ts`
| Function | Does |
|---|---|
| `buildServer()` | Registers the five tools above on an `McpServer`. |
| `required(name)` | Reads an env var or throws at startup. |

Exposes `GET /healthz`, `POST /mcp`, and `GET /mcp`.

## `services/notes-mcp-server/`

The second upstream. In-memory note store with two tools, `add_note` and `list_notes`, so the cross-server demo does not depend on a third party. State is intentionally not persisted. Three demo notes are created when the process starts.

## `services/dashboard/`

React + Vite. `src/api.ts` wraps `fetch` with the stored JWT. Pages:

| File | Does |
|---|---|
| `App.tsx` | Login and registration, then the nav shell. |
| `pages/ServersPage.tsx` | Lists servers with status, shows each server's tools, and lets an admin add, enable, disable, and remove them. |
| `pages/KeysPage.tsx` | Creates a key (shown once), lists them, revokes them. |
| `pages/AuditPage.tsx` | The audit table, refreshed every 5 seconds. |
| `pages/ChatPage.tsx` | The chat panel. Reads the server-sent event stream and shows tool calls inline. Tool results are summarized; the model still gets the full body. |

`nginx.conf` proxies `/api` and `/mcp` to the gateway, so the browser talks to one origin and there is no CORS config.

## `helm/urmiai/`

Umbrella chart. `charts/store` (MariaDB, WordPress, the init job), `charts/woocommerce-mcp`, `charts/notes-mcp`, `charts/gateway` (Postgres plus the gateway), `charts/dashboard`.

The init job in `charts/store/templates/wp-init-job.yaml` installs WordPress, activates WooCommerce, enables cash on delivery, creates one REST API key, and writes the raw key to a file on the shared volume. The WooCommerce MCP server mounts that volume read-only and waits for the file before starting. That avoids a manual copy step, because WooCommerce stores only the HMAC of the key and never the raw value.

`global.domain`, `global.storageClass`, and `global.tls` are the only environment-specific settings, and they live under `global` because that is the only key Helm passes from a parent chart into its subcharts. `values-local.yaml` and `values-prod.yaml` change nothing else.
