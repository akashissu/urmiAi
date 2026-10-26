# System design and tradeoffs

Short note for the submission. The longer plan is `docs/architecture.md`. Where that plan and the running chart disagree, this file describes what shipped.

## Architecture choices

Four processes, one Helm chart.

| Piece | Responsibility |
|---|---|
| WordPress + WooCommerce + MariaDB | The store. A human places an order here. |
| `services/woocommerce-mcp-server` | Streamable HTTP MCP over the WooCommerce REST API: list and create products, list and get orders, update order status. ClusterIP, no Ingress. |
| `services/notes-mcp-server` | Second upstream, in memory, so a demo does not depend on a public server staying up. |
| `services/gateway` | MCP client to each upstream, MCP server at `/mcp`, REST API, chat tool loop, Postgres. |
| `services/dashboard` | React UI. nginx serves the app and proxies `/api` and `/mcp` to the gateway, so the browser and an external client share one host. |

Node and TypeScript everywhere we write code, and `@modelcontextprotocol/sdk` for Streamable HTTP. One language means the gateway can be a client and a server without a second stack. The chat loop speaks OpenAI `/chat/completions` over HTTP. There is no provider SDK, so Groq or another compatible endpoint is three env vars.

The store and the platform share the namespace you install into (`platform` locally). The early diagram in `docs/architecture.md` shows a separate `store-default` namespace. That split is the multi-store bonus, and it was not built. One namespace keeps the first-party DNS names short (`woocommerce-mcp.platform.svc.cluster.local`) and the chart one `helm upgrade`.

API keys are argon2id hashes. Upstream credentials are AES-256-GCM. Those are different jobs: a gateway key is only verified, a WooCommerce key has to be sent on every call. The encryption key (`GATEWAY_KEK`) lives in the Secret `gateway-config`, not in Postgres.

## Tool aggregation, routing, and failure handling

On `tools/list`, `listAggregatedTools` loads every enabled server and calls each one with `Promise.allSettled` and a 15s timeout (`UPSTREAM_TIMEOUT_MS`). A failure is recorded against that slug and contributes no tools. The other servers are still returned. `Promise.all` would have dropped the whole list.

Each tool is renamed to `<slug>__<tool>`. The slug is unique and matches `[a-z0-9-]{2,40}`. Two servers can both expose `list`. A second registration of the same slug is a Postgres unique violation, returned as HTTP 409.

On `tools/call`, the name is split on the first `__`. The gateway loads that server, refuses the call if it is missing or disabled, decrypts that server's credential only, and calls the upstream tool under the same 15s timeout. The client's API key is not forwarded. Success and failure both write `audit_log` (user, server, tool, start, duration, outcome). An upstream result with `isError: true` is stored as `upstream_error`, not as a success. A timeout and a connection failure are different reasons (`timeout` vs `unreachable`), and the pooled client for that server is dropped so the next call reconnects.

A background health loop pings `tools/list` every 15s and sets `connected` or `unreachable`. The dashboard badge reads that column. Killing the notes pod flips the badge and does not stop WooCommerce calls.

`tools/list` and `tools/call` are handled on every request, not from a map built at process start. Disabling a server takes effect on the next call without a restart.

## What changes for production

Same templates. `helm/urmiai/values-local.yaml` vs `helm/urmiai/values-prod.yaml`.

| | Local (kind) | Production file (k3s) |
|---|---|---|
| DNS | `127.0.0.1 store.urmiai.local app.urmiai.local` in the hosts file. Kind maps host ports 80 and 443. | Real DNS: `store.<domain>` and `app.<domain>` to the node. |
| Ingress | ingress-nginx, TLS off. Two hosts, both path `/`. | Same class. `global.tls.enabled` adds the cert-manager annotation and a TLS secret on the dashboard host. Install cert-manager and a ClusterIssuer named `letsencrypt-prod`. k3s ships Traefik; this chart expects `ingressClassName: nginx`, so install ingress-nginx. |
| Storage class | `standard` (kind) | `local-path` (k3s). PVCs: WordPress files, MariaDB, Postgres. |
| Gateway replicas | 1 | 2 |
| Internal URLs | `allowInternalUpstreams: true` so the admin can register `*.svc.cluster.local`. | The file sets this `false`. Loopback, link-local, and `169.254.169.254` are always rejected. With the flag false, RFC1918 is rejected too, which includes the pod IPs of our own MCP servers. Registering WooCommerce and notes on a VPS therefore needs `--set gateway.allowInternalUpstreams=true`, or those two URLs fail the SSRF check. The flag is all-or-nothing. An allowlist of first-party service names would be the cleaner split, and it is not built. |
| Secrets | Placeholders in the chart (`changeme-local-only`, a 32-byte zero KEK). Obvious, and not real. | Do not commit real values. Pass them at install time with `--set-string`: `gateway.crypto.kek`, `gateway.auth.jwtSecret`, `gateway.llm.apiKey`, `gateway.postgres.password`, `store.mariadb.password`, `store.mariadb.rootPassword`, `store.wordpress.adminPassword`. `--set-string` because a key can contain dots, and plain `--set` splits on them. Omitting the LLM key on a later upgrade writes the empty chart default back into the Secret and chat stops. |

Images are built locally and loaded into kind. On a VPS, build the same four tags and import them into k3s containerd (`docker save ... | sudo k3s ctr images import -`). `imagePullPolicy` is `IfNotPresent`. There is no public registry in this repo.

Upgrade is `helm upgrade` with the same values file and the same `--set-string` secrets. Rollback is `helm rollback urmiai <revision> -n platform`. That restores the previous rendered manifests. It does not rewind Postgres or MariaDB. Volumes stay.

Commands and the order of operations are in the README and `docs/DEPLOY.md`.
