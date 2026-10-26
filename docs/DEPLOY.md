# Build and deploy

Run from the repo root. Requires Docker, kind, kubectl, and helm.

## 1. Cluster

```bash
kind create cluster --name urmiai
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl rollout status deployment -n ingress-nginx ingress-nginx-controller
```

Point the domains at the cluster. With kind, map the ingress controller's
ports 80/443 to localhost in the cluster config, then add to your hosts file:

```
127.0.0.1 store.urmiai.local app.urmiai.local
```

## 2. Images

```bash
for svc in gateway woocommerce-mcp-server notes-mcp-server dashboard; do
  docker build -t urmiai/${svc}:dev services/${svc}
  kind load docker-image urmiai/${svc}:dev --name urmiai
done
```

## 3. Install

```bash
helm dependency update helm/urmiai
helm upgrade --install urmiai helm/urmiai -n platform --create-namespace -f helm/urmiai/values-local.yaml
```

## 4. Wait for the store to finish bootstrapping

The `wp-init` job installs WordPress, activates WooCommerce, and writes the
REST API key to a file on the shared volume. The WooCommerce MCP server
mounts that volume and starts once the file exists, so there is no manual
copy step. Watch it with:

```bash
kubectl -n platform logs job/wp-init -f
kubectl -n platform rollout status deployment/woocommerce-mcp
```

## 5. Register the upstreams

Open http://app.urmiai.local, register the first account (it becomes admin),
and add:

| slug | base URL |
|---|---|
| woocommerce | http://woocommerce-mcp.platform.svc.cluster.local:8080/mcp |
| notes | http://notes-mcp.platform.svc.cluster.local:8080/mcp |
| weather | a public MCP server — see docs/third-upstream.md |

## 6. Production

Same command, different values file, on a k3s node:

```bash
helm upgrade --install urmiai helm/urmiai -n platform --create-namespace \
  -f helm/urmiai/values-prod.yaml \
  --set gateway.crypto.kek="$(openssl rand -base64 32)" \
  --set gateway.auth.jwtSecret="$(openssl rand -base64 48)" \
  --set gateway.llm.apiKey="$LLM_API_KEY"
```

Set DNS for `store.<domain>` and `app.<domain>` to the node, and install
cert-manager plus a ClusterIssuer named `letsencrypt-prod` if TLS is on.
