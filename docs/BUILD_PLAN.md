# Build Plan — 14 days, core first

Each day has: the work, the concrete APIs/contracts it produces, what it needs (tools, secrets, cluster resources), and a "done when" check you verify yourself before moving on. Bonus items only start after Day 12's full definition-of-done run passes.

---

## External APIs / services the whole system depends on

| Dependency | Used by | Auth | Notes |
|---|---|---|---|
| WooCommerce REST API v3 (`/wp-json/wc/v3`) | `woocommerce-mcp-server` | HTTP Basic, consumer key + secret | Official API, base URL is the in-cluster WordPress Service DNS name |
| Postgres | `gateway` | user/password in `DATABASE_URL` | gateway's own state only |
| LLM provider (OpenAI-compatible, e.g. Groq free tier) | `gateway` chat agent | Bearer API key | only needed from Day 11; swappable via `LLM_PROVIDER`/`LLM_BASE_URL` |
| ingress-nginx | cluster | n/a | installed once per cluster, not part of our chart |
| (Day 8) 2 extra upstream MCP servers | `gateway` consumes them | per-server, stored encrypted | at least one should be self-hosted so the demo doesn't depend on a third party being up |

---

## Environment variables / secrets, by service

### `woocommerce-mcp-server`
| Env var | Source | Purpose |
|---|---|---|
| `PORT` | value, default 8080 | listen port |
| `WC_BASE_URL` | Secret `store-wc-credentials` | in-cluster WordPress base URL |
| `WC_CONSUMER_KEY` | Secret `store-wc-credentials` | REST API consumer key |
| `WC_CONSUMER_SECRET` | Secret `store-wc-credentials` | REST API consumer secret |

### `gateway`
| Env var | Source | Purpose |
|---|---|---|
| `PORT` | value, default 8080 | listen port |
| `DATABASE_URL` | Secret `gateway-db` | Postgres connection string |
| `GATEWAY_KEK` | Secret `gateway-crypto` | 32-byte key, AES-256-GCM for upstream credentials |
| `JWT_SECRET` | Secret `gateway-auth` | signs dashboard session JWTs |
| `LLM_PROVIDER` | value | `groq` \| `openai` \| `ollama` |
| `LLM_BASE_URL` | value | OpenAI-compatible base URL |
| `LLM_API_KEY` | Secret `gateway-llm` | LLM provider key |
| `LLM_MODEL` | value | model name |
| `ALLOW_INTERNAL_UPSTREAMS` | value, `true` only in local | dev escape hatch for the SSRF guard (see INTERVIEW_PREP) |

### `dashboard`
| Env var | Source | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | build arg | empty string in-cluster (same origin via Ingress), full URL only for local `vite dev` |

---

## API surface the gateway exposes

All `/api/*` routes require `Authorization: Bearer <dashboard JWT>` except `register` and `login`. All `/mcp` calls require `Authorization: Bearer <api key>`.

### Auth
| Method | Path | Body | Returns | Who |
|---|---|---|---|---|
| POST | `/api/auth/register` | `{email, password}` | `{token, user}` — first registered user becomes `admin`, rest default to `member` | public |
| POST | `/api/auth/login` | `{email, password}` | `{token, user}` | public |
| GET | `/api/auth/me` | — | `{id, email, role}` | any user |

### API keys
| Method | Path | Body | Returns | Who |
|---|---|---|---|---|
| GET | `/api/keys` | — | `[{id, label, keyPrefix, isPrimary, revokedAt, lastUsedAt, createdAt}]` — never the raw key or hash | owner |
| POST | `/api/keys` | `{label}` | `{id, rawKey, keyPrefix}` — `rawKey` returned **once**, only here | owner |
| POST | `/api/keys/:id/revoke` | — | `{revokedAt}` | owner, or admin for any user |

### MCP servers (admin)
| Method | Path | Body | Returns | Who |
|---|---|---|---|---|
| GET | `/api/servers` | — | `[{id, slug, name, baseUrl, authType, enabled, status, lastCheckedAt}]` — credential fields never included | any user (members need to see status) |
| POST | `/api/servers` | `{slug, name, baseUrl, authType, authHeaderName?, credential?}` | the created server (no credential echoed back) | admin |
| PATCH | `/api/servers/:id` | any subset of the above | updated server | admin |
| POST | `/api/servers/:id/disable` | — | `{enabled: false}` | admin |
| POST | `/api/servers/:id/enable` | — | `{enabled: true}` | admin |
| DELETE | `/api/servers/:id` | — | `204` | admin |
| GET | `/api/servers/:id/tools` | — | live `tools/list` result for that one server, for the dashboard's "tools this server exposes" view | any user |

### Audit log
| Method | Path | Query | Returns | Who |
|---|---|---|---|---|
| GET | `/api/audit` | `?userId&serverSlug&limit&before` | `[{user, serverSlug, toolName, startedAt, durationMs, success, errorMessage}]` | admin sees all; member sees only their own |

### Chat
| Method | Path | Body | Returns | Who |
|---|---|---|---|---|
| POST | `/api/chat` | `{messages: [{role, content}]}` | `text/event-stream`: `tool_call`, `tool_result`, `token`, `done` events | any user; calls execute as that user |

### MCP endpoint (external clients + chat agent)
| Method | Path | Protocol | Who |
|---|---|---|---|
| POST | `/mcp` | MCP Streamable HTTP: `initialize`, `tools/list`, `tools/call` | any valid, non-revoked API key |
| GET | `/mcp` | SSE stream for an existing session | same |

### Health
| Method | Path | Returns | Used by |
|---|---|---|---|
| GET | `/healthz` | `{ok: true}` only if Postgres is reachable | readiness probe |
| GET | `/livez` | `{ok: true}` unconditionally | liveness probe |

---

## Day 1 — Cluster + Helm skeleton

**Work**: Kind (or k3d) cluster, ingress-nginx, umbrella chart with stub subcharts.
**Needs**: Docker Desktop, `kind`, `kubectl`, `helm`, ingress-nginx manifest.
**APIs produced**: none yet — each stub subchart serves only `GET /healthz`.
**Done when**: `helm install urmiai ./helm/urmiai -f helm/urmiai/values-local.yaml` succeeds on a fresh cluster and all pods reach Ready.

## Day 2 — Store chart

**Work**: MariaDB StatefulSet + PVC, WordPress Deployment + PVC, `wp-init` Job, Ingress.
**Needs**:
- StorageClass (`standard` on Kind, `local-path` on k3d/k3s)
- DNS: `store.urmiai.local` → cluster ingress IP (hosts file or local DNS)
- `wp-init` Job calls the WordPress REST/CLI internals, not a public API: `wp core install`, `wp plugin install woocommerce --activate`, then the WooCommerce REST API key endpoint `POST /wp-json/wc/v3/customers` isn't used — instead `wp eval` to call `wc_rand_hash`/`wc_api_hash` and insert into `wp_woocommerce_api_keys`, writing the raw key+secret into Secret `store-wc-credentials`.
**APIs produced** (by WordPress/WooCommerce, not by us): `GET/POST /wp-json/wc/v3/products`, `GET/POST/PUT /wp-json/wc/v3/orders`, `GET /wp-json/wc/v3/orders/:id`.
**Done when**: open the storefront, add a product to cart, check out with COD, see the order in WP admin.

## Day 3-4 — WooCommerce MCP server

**Work**: finish `services/woocommerce-mcp-server` (already scaffolded), Dockerfile, `charts/woocommerce-mcp`.
**Needs**: Secret `store-wc-credentials` from Day 2; image build + push to a local registry or `kind load`.
**APIs produced** (MCP, Streamable HTTP, ClusterIP only):

| Tool | Input | Maps to |
|---|---|---|
| `list_products` | `{search?, page?, perPage?}` | `GET /products` |
| `create_product` | `{name, regularPrice, description?, sku?, stockQuantity?}` | `POST /products` |
| `list_orders` | `{after?, status?, perPage?}` | `GET /orders` |
| `get_order` | `{orderId}` | `GET /orders/:id` |
| `update_order_status` | `{orderId, status}` | `PUT /orders/:id` |

Plus `GET /healthz`.
**Done when**: MCP Inspector (via `kubectl port-forward`, since there's no Ingress) lists and calls all 5 tools against the real store.

## Day 5-6 — Gateway: auth + registry

**Work**: `crypto/credentials.ts`, `auth/apiKeys.ts`, `auth/middleware.ts`, auth + API key + server CRUD routes, Postgres subchart.
**Needs**: Secret `gateway-db`, Secret `gateway-crypto` (generate `GATEWAY_KEK` with `openssl rand -base64 32`), Secret `gateway-auth`.
**APIs produced**: all of **Auth**, **API keys**, and **MCP servers** tables above, minus `GET /api/servers/:id/tools` (needs the MCP client, Day 7).
**Done when**: curl script proves — register, login, mint a key, call an authenticated route with it, revoke it, next call is rejected. Confirmed against the running pod, not just unit tests.

## Day 7 — Gateway: MCP aggregation + routing

**Work**: `mcp/upstreamPool.ts`, `mcp/aggregator.ts`, `mcp/healthLoop.ts`, `mcp/ssrfGuard.ts`, audit log writes, `/mcp` endpoint.
**Needs**: the WooCommerce MCP server from Day 4 registered via `POST /api/servers`; `ALLOW_INTERNAL_UPSTREAMS=true` in local values (its URL is cluster-internal DNS).
**APIs produced**:
- `POST /mcp` and `GET /mcp` (full MCP surface: `initialize`, `tools/list`, `tools/call`)
- `GET /api/servers/:id/tools`
- `GET /api/audit`
- `GET /healthz`, `GET /livez`
**Done when**: `tools/list` returns `woocommerce__*` prefixed tools; `tools/call` on one of them routes correctly and writes an `audit_log` row; killing the upstream's pod (or pointing it at a black-hole URL) produces a clean error row in `audit_log` instead of hanging the request.

## Day 8 — Two more upstreams

**Work**: pick and register 2 more MCP servers. Recommendation for demo reliability: write one tiny "notes" MCP server ourselves (so it can't go down on us) and use one public MCP server (e.g. a weather MCP) as the second.
**Needs**: whatever auth those two servers require, stored via the Day 6 credential encryption — never in the repo.
**APIs produced**: none new; this validates the Day 7 aggregation against real multiple upstreams.
**Done when**: a single MCP session calls a tool from the notes server and a tool from the second server; both appear in `audit_log` under the same user. Record the final choice and why in `docs/INTERVIEW_PREP.md`.

## Day 9-10 — Dashboard

**Work**: `services/dashboard` — login, server list with status, add/edit/disable/remove server, API key management, audit log table.
**Needs**: `VITE_API_BASE_URL` build arg; Ingress path `/` → dashboard, `/api` and `/mcp` → gateway (same host, no CORS).
**APIs consumed**: every `/api/*` route from Days 5-7. No new backend APIs expected; if one is missing, that's a gap to fix in the gateway, not to work around in the UI.
**Done when**: an admin completes the brief's "Team and control" user story entirely through the UI — no curl.

## Day 11 — Chat agent

**Work**: `chat/agent.ts` (LLM tool-calling loop) + chat panel with streaming transcript.
**Needs**: Secret `gateway-llm`; a verified working key before the demo (test it the day before, free tiers get rate-limited).
**APIs produced**: `POST /api/chat` (SSE). Internally it calls the gateway's own `tools/list` / `tools/call` functions in-process — no extra HTTP hop, same code path and same audit logging as an external client.
**Done when**: "what orders came in today" returns the real order placed on Day 2, and `audit_log` attributes the tool call to the logged-in user, not to a system account.

## Day 12 — Full definition-of-done run

**Work**: no new code unless a scenario fails. Two real users, every scenario in the brief.
**Needs**: a second user account (member role), a second API key, MCP Inspector or Cursor configured with only the gateway URL + that key.
**APIs exercised**: all of them, across both users.
**Done when**: every scenario in the brief's "Definition of done" section passes — create product via chat, place the order by hand, query today's orders both via chat (user A) and via an external client (user B), revoke B's key, disable one upstream, kill one upstream pod — and every call is in the audit log under the correct user.

## Day 13 — Production-like deploy

**Work**: finalize `values-prod.yaml`, deploy to a k3s VPS.
**Needs**: a VPS, a domain + DNS records for `store.<domain>` and `app.<domain>`, cert-manager + a ClusterIssuer if doing TLS, the same Secrets recreated on the VPS (never copied from the repo).
**APIs produced**: none — same chart, different values (domain, storage class, resource sizes, replica count, TLS annotations).
**Done when**: Day 12's flow passes on the VPS with zero template changes.

## Day 14 — Write-up + demo

**Work**: `docs/system-design-tradeoffs.md`, `docs/threat-model.md`, fill in README, record the demo video covering every point in the brief's "Demo video requirements" list.
**Needs**: nothing new.
**Done when**: the submission form has the repo URL and the demo video link.

## Guardrail for this plan

Do not start a day's work if the previous day's "done when" check isn't actually verified. An unfinished core is worth less than a finished one — per the brief itself.
