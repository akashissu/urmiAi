# How to test it

There are **two web UIs**. The MCP endpoint is not a third UI. It is the API an external client (Cursor, or the script at the bottom) calls.

| What you open | What it is | URL on this machine |
|---|---|---|
| Dashboard | React app. Login, servers, API keys, audit, chat. | http://127.0.0.1:18080 or http://app.urmiai.local |
| Store | WordPress + WooCommerce. The shop a customer uses. | http://store.urmiai.local |
| MCP | Streamable HTTP on the gateway. No page. | http://127.0.0.1:18080/mcp |

The dashboard and the store do not share a login. Dashboard users are rows in the gateway's Postgres. The store admin is a WordPress user.

## How a request moves

1. You register an upstream once in the dashboard (WooCommerce, notes). The URL is stored in Postgres. If the upstream needs a token, the gateway encrypts it with `GATEWAY_KEK` and never sends it back to the browser.
2. You create an API key. The browser shows the raw `urmiai_...` value once. Only an argon2 hash is stored.
3. An MCP client sends `Authorization: Bearer urmiai_...` to `POST /mcp`. The dashboard's nginx forwards `/mcp` and `/api` to the gateway, so the client uses the dashboard's address.
4. `tools/list` asks every enabled upstream and prefixes names: `woocommerce__list_products`, `notes__add_note`.
5. `tools/call` splits on the first `__`, calls that upstream, and writes one audit row under the user who owns the key.
6. The WooCommerce MCP server (ClusterIP, no Ingress) calls the store's REST API. The store is the only place a human adds something to a cart and pays.
7. Chat uses the same tool path, but only after `LLM_API_KEY` is set. Until then it returns `LLM_API_KEY is not configured`.

## Accounts already on this cluster

| App | Who | Password | Role |
|---|---|---|---|
| Dashboard | `admin@example.com` | `password123` | admin. First account registered. |
| Store /wp-admin | `admin` | `changeme-local-only` | WordPress admin. From the Helm values, not a real secret. |

A second dashboard account becomes `member`. Members can see servers, issue their own keys, read their own audit rows, and chat. They cannot add, disable, or remove a server.

## Short demo video

The shop is seeded with five products and three orders (`deploy/seed-demo.php`). Chat is already on OpenAI. Film this and skip the long checklist below.

1. http://store.urmiai.local/shop/ — Stoneware Mug $18, Pour-Over Kettle $42, Linen Notebook $14, Wool Throw $68, Brass Desk Lamp $54.
2. Dashboard, `admin@example.com` / `password123`. **MCP Servers**: WooCommerce and Notes, both `connected`. Click **Tools** on each.
3. **Chat Agent**: `Which orders are still processing?` — Luis Ortega (kettle, $42) and Asha Reddy (two notebooks, $28).
4. Same chat: `Mark Luis Ortega's order completed.` — status becomes `completed`.
5. Same chat: `What notes do we have?` — restock mugs, gift wrap for Luis, wholesale ask from Northwind Cafe.
6. **Audit Log** — those three calls are `ok` rows for `admin@example.com`.

Re-seed the store with `Get-Content deploy\seed-demo.php -Raw | kubectl exec -i -n platform deploy/wordpress -- php`. Notes come back on their own when that pod restarts.

## 0. Cluster is up

Docker Desktop has to be running. Then:

```powershell
kubectl get pods -n platform
```

Every pod except `wp-init` should be `1/1 Running`. `wp-init` stays `Completed`.

If `app.urmiai.local` does not resolve, skip the hosts file and use the port-forward. Run these in separate terminals and leave them open:

```powershell
kubectl -n platform port-forward svc/dashboard 18080:8080
```

The store needs the Host header `store.urmiai.local`. The reliable way is an Administrator PowerShell:

```powershell
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "127.0.0.1 store.urmiai.local app.urmiai.local"
```

Kind already publishes ingress on port 80, so after that line both names open in the browser. Without it, use http://127.0.0.1:18080 for the dashboard only.

## 1. Dashboard login

1. Open http://127.0.0.1:18080
2. Email `admin@example.com`, password `password123`, Log in.
3. The left rail shows `admin@example.com` and `admin`.

Wrong password stays on the form and says `Invalid email or password`. Log out is at the bottom of the rail. Use it at the end of step 8.

## 2. Servers

You should see two cards, both badged `connected`:

| Name | URL |
|---|---|
| WooCommerce | `http://woocommerce-mcp.platform.svc.cluster.local:8080/mcp` |
| Notes | `http://notes-mcp.platform.svc.cluster.local:8080/mcp` |

If a card says `unreachable`, wait 15 seconds and reload. That is the health loop.

Click **Tools** on WooCommerce. Five names:

- `list_products`
- `create_product`
- `list_orders`
- `get_order`
- `update_order_status`

Click **Tools** on Notes. Two names: `add_note`, `list_notes`.

This button only lists tools. It does not run them. Running them is step 6 or step 11.

## 3. A bad server URL is rejected

In **Add MCP server**:

- slug: `looptest`
- display name: `Loop`
- URL: `http://127.0.0.1:9/mcp`

Add server. The form shows `Upstream URL resolves to a blocked address (127.0.0.1)`. No new card appears.

## 4. Disable and enable

Click **Disable** on Notes. The badge becomes `disabled`. Click **Tools** again if it was open; the notes tools are gone from the gateway on the next MCP `tools/list` (step 6). Click **Enable**. The badge goes back to `connected`.

Do not click **Remove** on WooCommerce or Notes.

## 5. API key

1. Open **API Keys**.
2. Label `cursor`, click **Generate key**.
3. Copy the `urmiai_...` value from the banner. It is not shown again. The table shows only the prefix.
4. The `chat-agent` key is hidden on purpose. Chat uses the dashboard session, not that key.

Leave this key in place until step 12.

## 6. Call a tool

The dashboard has no "run tool" button. Point any MCP client at the gateway.

Cursor, `mcp.json`:

```json
{
  "mcpServers": {
    "urmiai": {
      "url": "http://127.0.0.1:18080/mcp",
      "headers": {
        "Authorization": "Bearer PASTE_THE_KEY"
      }
    }
  }
}
```

Then ask Cursor to call `woocommerce__list_products` with `{}`. You should get JSON products, including the mugs created by earlier tests (`Manual Mug ...`, `E2E Mug ...`).

Or from `services/gateway`, with the key in the environment:

```powershell
$env:URMIAI_KEY = "urmiai_..."
node --input-type=module -e "import { Client } from '@modelcontextprotocol/sdk/client/index.js'; import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'; const c = new Client({name:'me',version:'0'}); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18080/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + process.env.URMIAI_KEY } } })); console.log((await c.listTools()).tools.map(t => t.name).join('\n')); const r = await c.callTool({ name: 'notes__add_note', arguments: { text: 'hello from the guide' } }); console.log(JSON.stringify(r).slice(0, 400)); await c.close();"
```

Expected tool names:

```
gateway_status
notes__add_note
notes__list_notes
woocommerce__list_products
woocommerce__create_product
woocommerce__list_orders
woocommerce__get_order
woocommerce__update_order_status
```

`notes__add_note` returns the note text you sent.

To create a product the store will actually sell:

```text
tool: woocommerce__create_product
arguments: { "name": "Guide Mug", "regularPrice": "15.00", "stockQuantity": 4 }
```

Copy the `id` from the result. You need it for the cart link in step 9.

## 7. Audit log

Open **Audit Log**. The note call and the product call are rows for `admin@example.com`, result `ok`, server `notes` or `woocommerce`. A failed call (disabled server, bad arguments) is a row whose Result column is the error text, not `ok`.

`gateway_status` does not appear. It is not a real upstream call.

## 8. Member

1. Log out.
2. **Need an account? Register**. Use a new email and a password of at least 8 characters.
3. The rail says `member`.
4. **MCP Servers** shows the same two cards and **Tools** only. There is no Disable, Remove, or Add form.
5. **Audit Log** does not list the admin's rows. It is empty until this user calls a tool with their own key.
6. Log out and log back in as `admin@example.com`.

## 9. Store

Open http://store.urmiai.local/shop/

You should see the products created through the gateway. Open one. **Add to cart**. Open **Cart**. The line and the price are there. Open **Checkout**.

- Empty cart: checkout redirects back to the cart. That is WooCommerce, not a broken page.
- With an item: checkout shows billing fields and **Cash on delivery**.

Place the order (any billing name, a real-looking email). The thank-you page has an order number.

Store admin, if you want to see the same order in wp-admin: http://store.urmiai.local/wp-admin — user `admin`, password `changeme-local-only`. WooCommerce → Orders.

## 10. That order through MCP

With the admin API key from step 5, call:

```text
woocommerce__list_orders   { "status": "processing", "perPage": 5 }
woocommerce__get_order     { "orderId": ORDER_NUMBER }
woocommerce__update_order_status  { "orderId": ORDER_NUMBER, "status": "completed" }
```

`get_order` includes the email you typed at checkout. After the update, `status` is `completed`. Refresh **Audit Log**. Three new `ok` rows for `admin@example.com`.

`get_order` with a nonsense id (`999999`) is an error row, not `ok`.

## 11. Turn chat on

Chat does nothing useful until `LLM_API_KEY` is set. The gateway speaks OpenAI `/chat/completions`. `.env` points at OpenAI.

1. Open https://platform.openai.com/api-keys and create a key. It starts with `sk-`.
2. Paste it into `.env`:

```
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1-mini
```

The cluster will not notice the file on its own. From the repo root. `--set-string` is required because a key can contain dots, and plain `--set` splits on them:

```powershell
function Read-Env([string]$name) {
  ((Get-Content .env | Where-Object { $_ -match "^$name=" }) -replace "^$name=", '').Trim()
}
helm upgrade urmiai helm/urmiai -n platform -f helm/urmiai/values-local.yaml `
  --set-string gateway.llm.apiKey="$(Read-Env LLM_API_KEY)" `
  --set-string gateway.llm.baseUrl="$(Read-Env LLM_BASE_URL)" `
  --set-string gateway.llm.model="$(Read-Env LLM_MODEL)"
kubectl -n platform rollout status deploy/gateway
```

Then in the dashboard, **Chat Agent**, send: `What orders came in today?`

A working key streams `calling woocommerce__list_orders(...)`, then a result, then a normal answer. **Audit Log** shows that tool call under your dashboard email, the same as if Cursor had called it.

With the key still empty, the same box shows `error: LLM_API_KEY is not configured` and Send comes back. No audit row is written, because no tool ran.

Groq’s free tier works too if you change the two lines to `https://api.groq.com/openai/v1` and `llama-3.3-70b-versatile` and run the same Helm command. The other names in `.env` are documentation of what the chart already injects. Editing `JWT_SECRET` in `.env` does not rotate the running secret.

## 12. Revoke the key

**API Keys** → **Revoke** on the `cursor` row. The cell says `revoked`. Call `tools/list` again with that same key. The gateway responds `Invalid or revoked API key`. Revoke on an already-revoked key is not offered; the API returns 404 if you try twice.

## One-shot script

`services/gateway/manual-e2e.mjs` does this whole list over HTTP, including the storefront and a member account. It needs the port-forwards (dashboard `18080`, gateway `18082`, notes `18083`, WooCommerce MCP `18084`) and ingress on port 80.

```powershell
cd services\gateway
node manual-e2e.mjs
```

The last line is `ALL_PASS` or a count. That script creates another product and another member each time it runs.
