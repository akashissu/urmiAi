# UrmiAi — MCP Gateway on Kubernetes

Urumi AI FDE Internship, Round 1. A WooCommerce store and a team MCP gateway, one Helm chart. Local kind and a k3s VPS use the same templates. Only the values file changes.

An admin registers upstream MCP servers once. Members use them through one MCP endpoint and through the chat agent, without seeing the upstream credentials. The first upstream is a WooCommerce MCP server written for this project.

## Repository map

| Path | What it is |
|---|---|
| `services/gateway` | MCP aggregator, REST API, and the chat agent (`src/chat/agent.ts`) |
| `services/woocommerce-mcp-server` | MCP server over the WooCommerce REST API |
| `services/notes-mcp-server` | Second upstream, in memory |
| `services/dashboard` | React dashboard |
| `helm/urmiai` | Umbrella chart. `values-local.yaml` and `values-prod.yaml` |
| `docs/DEPLOY.md` | The same install, as a shorter command list |
| `docs/HOW_TO_TEST.md` | Click-by-click check of both UIs |
| `docs/system-design-tradeoffs.md` | Architecture, routing, failure handling, production diffs |
| `docs/threat-model.md` | Credentials, token isolation, untrusted tools, members |
| `docs/architecture.md` | The original design note. The shipped namespace layout is the tradeoff doc. |
| `.env.example` | Env var names. Copy to `.env`. `.env` is gitignored. |

## Local setup

Needs Docker, kind, kubectl, and Helm. From the repo root.

```bash
kind create cluster --name urmiai --config deploy/kind-config.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl rollout status deployment -n ingress-nginx ingress-nginx-controller --timeout=180s

for svc in gateway woocommerce-mcp-server notes-mcp-server dashboard; do
  docker build -t urmiai/${svc}:dev services/${svc}
  kind load docker-image urmiai/${svc}:dev --name urmiai
done

helm dependency update helm/urmiai
helm upgrade --install urmiai helm/urmiai -n platform --create-namespace \
  -f helm/urmiai/values-local.yaml
```

On Windows the image loop is four separate `docker build` / `kind load` commands, and the hosts file is `C:\Windows\System32\drivers\etc\hosts`.

Add this line, then open the two hosts:

```
127.0.0.1 store.urmiai.local app.urmiai.local
```

| URL | What |
|---|---|
| http://store.urmiai.local | Shop |
| http://app.urmiai.local | Dashboard |
| http://app.urmiai.local/mcp | Gateway MCP. Not a page. |

If the hosts file is not an option, `kubectl -n platform port-forward svc/dashboard 18080:8080` and use http://127.0.0.1:18080. The shop still needs the `store.urmiai.local` Host header.

Wait until the store finishes:

```bash
kubectl -n platform logs job/wp-init -f
kubectl -n platform rollout status deployment/woocommerce-mcp
```

`wp-init` stays `Completed`. Other pods should be `Running`.

Register the first dashboard account. That user is the admin. Local passwords already in the chart are `changeme-local-only` (WordPress admin user `admin`, database passwords, JWT placeholder, a 32-byte zero `GATEWAY_KEK`). They are dev placeholders, not real secrets.

In **MCP Servers**, add:

| slug | URL |
|---|---|
| `woocommerce` | `http://woocommerce-mcp.platform.svc.cluster.local:8080/mcp` |
| `notes` | `http://notes-mcp.platform.svc.cluster.local:8080/mcp` |

A third upstream is registered the same way at runtime. See `docs/third-upstream.md`. It is not baked into the chart.

Chat needs an LLM key. Kubernetes does not read `.env`. Put the key in `.env` (see `.env.example`) and upgrade with `--set-string`, because a key can contain dots and plain `--set` splits on them:

```bash
helm upgrade urmiai helm/urmiai -n platform -f helm/urmiai/values-local.yaml \
  --set-string gateway.llm.apiKey="$LLM_API_KEY" \
  --set-string gateway.llm.baseUrl="https://api.openai.com/v1" \
  --set-string gateway.llm.model="gpt-4.1-mini"
kubectl -n platform rollout status deploy/gateway
```

The chart default model is `gpt-4.1-mini`. Groq is the same three fields with `https://api.groq.com/openai/v1` and `llama-3.3-70b-versatile`.

Optional shop fixtures for a demo: `deploy/seed-demo.php` (five products, three cash-on-delivery orders). It is not part of the chart.

```bash
kubectl exec -i -n platform deploy/wordpress -- php < deploy/seed-demo.php
```

## Place an order

1. http://store.urmiai.local/shop/ — open a product, **Add to cart**, **Checkout**.
2. Fill billing (email, name, address, city, state, postcode). Payment method **Cash on delivery**.
3. Place the order. The thank-you page shows the order number.
4. An empty cart sends checkout back to the cart. That is WooCommerce.

The store login is not the dashboard login. WordPress admin is http://store.urmiai.local/wp-admin — user `admin`, password `changeme-local-only`.

To create the product from the gateway instead of wp-admin, call `woocommerce__create_product` with `{ "name": "Guide Mug", "regularPrice": "15.00", "stockQuantity": 4 }`, then buy it on the shop.

## Connect an external MCP client

In the dashboard, **API Keys**, generate a key. The raw `urmiai_...` value is shown once. Only an argon2 hash is stored.

Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "urmiai": {
      "url": "http://app.urmiai.local/mcp",
      "headers": {
        "Authorization": "Bearer PASTE_THE_KEY"
      }
    }
  }
}
```

Use `http://127.0.0.1:18080/mcp` if you are on the port-forward. Tool names are prefixed: `woocommerce__list_orders`, `notes__list_notes`. A revoked key gets `Invalid or revoked API key`.

## Use the chat agent

Log into the dashboard, open **Chat Agent**, and send a question that needs the store, for example `Which orders are still processing?` or `Mark order 31 completed.`

The panel shows each tool call, then a short result line, then the model's answer. **Audit Log** records the call under the logged-in email. Chat uses the dashboard JWT and calls tools in-process as that user. It does not send the JWT or the user's API key to WooCommerce.

If the LLM key was not injected, the panel says `LLM_API_KEY is not configured` and no audit row is written.

## VPS (k3s)

Same chart. Install k3s, then ingress-nginx (the chart's class is `nginx`, not Traefik), and cert-manager with a ClusterIssuer named `letsencrypt-prod` if you keep TLS on.

Point DNS:

```
store.example.com  -> the node
app.example.com    -> the node
```

`values-prod.yaml` sets `global.domain` to `example.com`. Change that domain before installing, or override `global.domain`.

Build the four images on the node (or copy them) and import into containerd. `imagePullPolicy` is `IfNotPresent`.

```bash
for svc in gateway woocommerce-mcp-server notes-mcp-server dashboard; do
  docker build -t urmiai/${svc}:dev services/${svc}
  docker save urmiai/${svc}:dev | sudo k3s ctr images import -
done

helm dependency update helm/urmiai
helm upgrade --install urmiai helm/urmiai -n platform --create-namespace \
  -f helm/urmiai/values-prod.yaml \
  --set gateway.allowInternalUpstreams=true \
  --set-string gateway.crypto.kek="$(openssl rand -base64 32)" \
  --set-string gateway.auth.jwtSecret="$(openssl rand -base64 48)" \
  --set-string gateway.llm.apiKey="$LLM_API_KEY" \
  --set-string gateway.llm.baseUrl="https://api.openai.com/v1" \
  --set-string gateway.llm.model="gpt-4.1-mini" \
  --set-string gateway.postgres.password="$(openssl rand -hex 24)" \
  --set-string store.mariadb.rootPassword="$(openssl rand -hex 24)" \
  --set-string store.mariadb.password="$(openssl rand -hex 24)" \
  --set-string store.wordpress.adminPassword="$(openssl rand -hex 18)"
```

`allowInternalUpstreams=true` is required to register the in-cluster WooCommerce and notes URLs. `values-prod.yaml` leaves it `false` so private addresses are blocked; the override is the explicit exception, explained in `docs/system-design-tradeoffs.md`. Do not put the generated secrets in git. Repeat every `--set-string` on later upgrades or Helm writes the empty LLM key from the chart back into the Secret.

```bash
helm history urmiai -n platform
helm rollback urmiai <revision> -n platform
```

Rollback restores the previous manifests. Database volumes are not rewound.

This repo was brought up on kind. The VPS path is the same chart and has not been executed on a public node.

## Bonus and stand-out items

Not attempted: multi-store provisioning, per-tool permissions, gateway OAuth, a tool-search layer for large catalogs, hosted MCP servers (deploy by image), NetworkPolicies, non-root everywhere, Kubernetes RBAC, rate limits, and a metrics endpoint. A live k3s VPS was not deployed.

Shipped beyond the minimum path:

| Item | Where |
|---|---|
| SSRF check on admin-supplied upstream URLs (loopback, link-local, metadata IP, and RFC1918 unless the local flag is on) | `services/gateway/src/mcp/ssrfGuard.ts`, `gateway.allowInternalUpstreams` in the two values files |
| Upstream credentials encrypted at rest (AES-256-GCM), API keys hashed (argon2id) | `services/gateway/src/crypto/credentials.ts`, `services/gateway/src/auth/apiKeys.ts` |
| Dead-upstream isolation, timeouts, and a status badge | `services/gateway/src/mcp/aggregator.ts`, `services/gateway/src/mcp/healthLoop.ts` |
| Production values: domain, TLS annotation, storage class, two gateway replicas | `helm/urmiai/values-prod.yaml` |
| Upgrade and rollback | `helm upgrade` / `helm rollback`, described above and in the tradeoff note |

## Status

The chart runs on a local kind cluster: product and order tools, cash-on-delivery checkout, audit log, member vs admin, revoked keys, and a killed upstream pod. Record of that run: `docs/SYSTEM_TEST.md`. Still open: a third public MCP server (`docs/third-upstream.md`) and a deployment on an actual VPS.
