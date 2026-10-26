# Whole-system test — 26 Oct 2026

## Browser pass, 26 Oct 2026 night

Walked both UIs in the Cursor browser after the new AI Studio key was applied to `gateway-config`.

`gemini-3.8-flash` still returns 503. `gemini-3.1-flash-lite` answered and emitted a tool call, so the running gateway and `.env` now use that model. The first chat turn called `woocommerce__list_products` and then Google rejected the second round with 400 because the function call was missing `thought_signature`. `runChatTurn` now sends Gemini's `extra_content` back on the next request. After that image was loaded, chat listed the mugs with prices, and a second turn read order 24 and marked it `completed`.

Dashboard, as a member then as `admin@example.com`:

- WooCommerce tools: list/create products, list/get orders, update order status. Notes tools: add_note, list_notes. Both servers `connected`.
- A member sees the servers and Tools only. No Disable, Remove, or Add form. Their audit log is one row, their own `notes__add_note`.
- Wrong password shows `Invalid email or password`. Admin login shows every user's rows, including the red error rows.
- Loopback `http://127.0.0.1:9/mcp` is rejected: `Upstream URL resolves to a blocked address (127.0.0.1)`.
- Adding slug `woocommerce` again returns `A server with slug woocommerce is already registered`.
- Notes disable flips the badge to `disabled`, Enable puts it back to `connected`.
- A new key is shown once. Revoke on that row changes the cell to `revoked`.
- Chat tool calls are audit rows for `admin@example.com` with result `ok`.

Store at `http://store.urmiai.local/shop/`: five mugs, prices $19.99 and $24.50. Added Manual Mug 1793030712074, checkout showed Cash on delivery and $24.50, and Place Order produced order **24** for `browser-buyer@example.com`. Chat then set that order to `completed`.

## Full pass after the Gemini key and the store name, 26 Oct 2026 evening

`node services/gateway/manual-e2e.mjs` — 78 of 84 checks passed on the first complete run. The six misses:

- Chat reached Google and Google returned 503, "this model is currently experiencing high demand," for `gemini-3.8-flash` and `gemini-3.1-flash-lite`. `gemini-2.5-flash` is 404 for this new key. The gateway reported that error in the SSE stream and did not write a fake audit row. The key itself is accepted: listing models from inside the pod returned 200.
- The shop page was WooCommerce's coming-soon screen (`woocommerce_coming_soon=yes`), so the HTML had no product names and checkout had no cart. That option is now `no`, and the init job sets it that way. After the change, `http://store.urmiai.local/shop/` returns 200 and includes `Manual Mug 1793030712074`, the product page shows `24.50`, and checkout loads that mug with the `cod` payment method.

Everything else in that run passed: login, member role, keys, both MCP servers directly and through the gateway, create product id 19, COD order 20 completed through the gateway, notes, disable/enable, audit, SSRF, revoked key, and `app.urmiai.local`.

## Manual pass, evening

`node services/gateway/manual-e2e.mjs` walks every route and every tool against the live cluster. The evening run was 80 checks. 78 passed on the first complete pass. The two misses were not product bugs: `gateway_status` still listed a leftover `manualtemp` server from a crashed earlier attempt (it was deleted at the end of the same run), and `/checkout/` returns 302 when the cart is empty. Adding product 16 to the cart and requesting `/checkout/` with that cookie returned 200 and the cash-on-delivery form.

The same pass is what found two real defects, both fixed and redeployed in `urmiai/gateway:dev` before the 80-check run:

- Registering a slug that already exists threw Postgres `23505` out of the route and the process restarted. It now returns 409 `A server with slug … is already registered`.
- An upstream tool that returned `isError: true` (missing order, bad enum, unknown tool) was stored as a successful audit row and a successful MCP result. `callAggregatedTool` now turns that into `upstream_error`, so the client gets `isError` and the audit row records the message.

Dashboard, clicked through at `http://127.0.0.1:18080` after that deploy:

- Logged-in admin sees WooCommerce and Notes, both `connected`. Tools expands to the five WooCommerce tools.
- Adding `http://127.0.0.1:9/mcp` shows `Upstream URL resolves to a blocked address (127.0.0.1)` and does not create a server.
- Generating a key shows the raw `urmiai_…` value once. Revoke flips that row to `revoked`. The primary `chat-agent` key is not in the table.
- Audit shows the admin product calls, the member's `notes__add_note`, and the failed calls (disabled server, unknown tool, empty note) with the real message.
- Chat shows `error: LLM_API_KEY is not configured`.
- A wrong password stays on the login form with `Invalid email or password`.
- The member account sees both servers and a Tools button only. No Disable, Remove, or Add form. Their audit table is the one note they created.

What that script covered, all passing after the fix: gateway `/livez` and `/healthz`, both upstream `/healthz`, direct MCP to notes and WooCommerce (not through the gateway), gateway `tools/list` via the dashboard proxy and via the gateway port, `gateway_status`, create product with price sku and stock, list, COD order for two units, list/get/update order to `on-hold` then `completed`, missing order, bad status, add/list notes, empty note, unknown tool, unknown server, member 403 on register and disable, SSRF loopback and metadata, bearer credential not echoed, unreachable server 502 that names the slug, duplicate slug 409, disable hides tools and the call says `disabled`, member tool call attributed to the member, revoked key rejected, revoke twice is 404, chat SSE, shop, product page, cart, my-account, `/wp-json/` as JSON, unauthenticated WooCommerce REST 401, ingress `Host: app.urmiai.local`.

Still not in the product, confirmed rather than assumed: `PATCH /api/servers/:id` is 404, and `GET /api/audit?serverSlug=` ignores the filter. Chat still cannot call tools until an LLM key is set. No third public MCP server. `store.urmiai.local` still does not resolve without a hosts entry.

The kind cluster `urmiai` was already up in namespace `platform`. This pass checked the path the assignment asks for: dashboard login, both upstreams, a real WooCommerce write, an order, the gateway MCP endpoint, audit, roles, a revoked key, chat, the public shop, and what happens when the WooCommerce MCP pod is gone.

Result: the scripted run printed `ALL_PASS`. The dashboard showed the same facts in the browser. Two things are still open and are called out at the bottom: there is no LLM key, and a third public MCP server is not registered.

## How a call moves

1. The browser talks only to the dashboard. nginx in that pod proxies `/api` and `/mcp` to the gateway.
2. Dashboard login returns a 12-hour JWT. MCP clients do not use that JWT. They use an API key, sent as `Authorization: Bearer urmiai_...` to `POST /mcp`.
3. The gateway checks the key (argon2id, lookup by the 8-character prefix). A revoked key is rejected before any tool runs.
4. `tools/list` and `tools/call` are not the SDK's static tool map. Both handlers were replaced. The list is rebuilt from enabled upstreams on every request. A call name is split on the first `__`: `woocommerce__create_product` goes to the server whose slug is `woocommerce`, tool `create_product`.
5. The gateway opens its own MCP client to that upstream, waits at most 15 seconds, and writes one `audit_log` row under the user who owns the key. `gateway_status` is the exception: it only reports tool count and failures, and it is not audited.
6. The WooCommerce MCP server calls `http://wordpress/wp-json/wc/v3` with `consumer_key` and `consumer_secret` on the query string. It reads those from `/var/www/html/.urmiai-wc-key`, which the init job created. WooCommerce stores only the HMAC of the key, so the file is the only copy of the raw key.
7. Notes stay in memory inside the notes MCP process. Disabling that server removes `notes__*` from the next `tools/list` without restarting the gateway.

## What had to be fixed before the product call would succeed

WooCommerce 9.9 only accepts a consumer key when `is_ssl()` is true (`includes/class-wc-rest-authentication.php`, the basic-auth branch, which is also where query-string keys are read). Inside the cluster the store is plain HTTP, so a correct key still returned `woocommerce_rest_cannot_view`.

The key itself was already valid: prefix `ck_5344`, hash and secret matched `wp_woocommerce_api_keys`, and the WooCommerce MCP process had both variables in pid 1's environment.

Fix, applied on the running WordPress volume and in `helm/urmiai/charts/store/templates/wp-init-job.yaml` so a reinstall does it too: if the request carries `consumer_key`, set `$_SERVER['HTTPS'] = 'on'` at the top of `wp-config.php`. Normal page views stay HTTP. After that, `GET /wp-json/wc/v3/products` from inside the WooCommerce MCP pod returned `200` and `[]`.

The readable source of that patch is `deploy/allow-rest.php`. The init job embeds the same script as base64 so the shell quoting stays boring.

## How this was run

Port-forwards that were already listening:

| Local | Pod | Used for |
|---|---|---|
| `127.0.0.1:18080` | `dashboard:8080` | Login, REST, and MCP. This is the same origin the browser uses. |
| `127.0.0.1:80` | kind ingress | Shop and product pages, with `Host: store.urmiai.local` |
| `127.0.0.1:18081` | `wordpress:80` | Direct Apache. Not used by the script. |

`app.urmiai.local` and `store.urmiai.local` are not in the Windows hosts file. Writing it was denied without an Administrator shell. Ingress on port 80 routes by the Host header, so the script sets that header with `node:http`. `fetch()` cannot set `Host`, and that is why an earlier shop check reported nginx 404.

Repeat the scripted run from `services/gateway` (the MCP SDK is installed there):

```bash
kubectl -n platform port-forward svc/dashboard 18080:8080
node e2e-once.mjs
```

The script logs in as `admin@example.com`, creates a throwaway API key, talks MCP to `http://127.0.0.1:18080/mcp`, creates a product, places a cash-on-delivery order through WordPress (`kubectl exec` into `deploy/wordpress`), then lists, gets, and completes that order through the gateway. It also registers a second user, checks that a member cannot see the admin's audit rows and cannot disable a server, revokes the throwaway key, hits chat, and fetches the shop.

## Script result

`node e2e-once.mjs` ended with `ALL_PASS`. The run that counts:

| Check | Result |
|---|---|
| Login | 200, role `admin` |
| Servers | `woocommerce:connected`, `notes:connected` |
| WooCommerce tools | `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| Notes tools | `add_note`, `list_notes` |
| Issue key | 201, prefix `urmiai_0`, raw key returned once |
| `tools/list` | `gateway_status` plus `notes__*` and `woocommerce__*` |
| Create product | `E2E Mug 1792989292213`, id 12, price 19.99, slug `e2e-mug-1792989292213` |
| List products | That mug is in the search result |
| COD order | Order 13, total 19.99, status `processing`, billing `buyer@example.com` |
| List / get / complete | Gateway returned order 13, then status `completed` |
| Notes | `notes__add_note` returned the text that was sent |
| Disable notes | Next `tools/list` has no `notes__*` and still has `woocommerce__*` |
| Enable notes | `notes__list_notes` is back |
| Audit | Those calls are rows for `admin@example.com`, `success` true |
| Second user | `member-1792989317916@example.com` registered as `member` |
| Member audit | 0 rows. The admin's calls are not in there. |
| Member disable | `POST /api/servers/:id/disable` returned 403 |
| Revoked key | Next MCP call returned `Invalid or revoked API key` |
| Chat | HTTP 200, SSE `event: error` with `LLM_API_KEY is not configured`, then `event: done` |
| Shop | `http://127.0.0.1/shop/` with `Host: store.urmiai.local` returned 200 and the mug's name |
| Product page | `/product/e2e-mug-1792989292213/` returned 200 |

The order is not placed by the MCP server. There is no `create_order` tool. The script creates the order inside WordPress with cash on delivery, which is the payment method the init job turned on, then the gateway tools are what list it, read it, and mark it completed. That matches the assignment: the agent updates order status; a person checks out on the storefront.

## Dashboard, in the browser

Opened `http://127.0.0.1:18080/` in the Cursor browser. The session was already `admin@example.com` / `admin`.

- Servers page: WooCommerce and Notes both badged `connected`, with the cluster URLs `http://woocommerce-mcp.platform.svc.cluster.local:8080/mcp` and `http://notes-mcp.platform.svc.cluster.local:8080/mcp`.
- Tools on WooCommerce expanded to the five tools above, with their descriptions.
- Audit log showed the same rows as the script, newest first, each `ok`. The 10:05 run is `notes__add_note`, `woocommerce__update_order_status` (840 ms), `woocommerce__get_order`, `woocommerce__list_orders`, `woocommerce__list_products`, `woocommerce__create_product` (5650 ms).
- Chat Agent: sent "What orders came in today?" and the transcript showed `error: LLM_API_KEY is not configured`. The input is disabled while the request is in flight, then Send comes back.

## Killing the WooCommerce MCP pod

`kubectl scale deploy/woocommerce-mcp -n platform --replicas=0`, then waited until the pod was gone, then called `tools/list` and `gateway_status` on the gateway.

While it was down the list was only `gateway_status`, `notes__add_note`, `notes__list_notes`. Status was `{"toolCount":2,"failures":[{"serverSlug":"woocommerce","message":"fetch failed"}]}`. Notes kept working. The failed upstream did not hang the list past its own timeout.

`kubectl scale deploy/woocommerce-mcp -n platform --replicas=1` and `kubectl rollout status` brought it back. The next list had all seven tools, `failures` was empty, and both servers reported `connected`.

A delete-and-immediately-list did not catch the outage. The replacement pod was Ready before the 15 second timeout, so the list still contained the WooCommerce tools. Scale to zero is the check that actually holds the server down.

## What is still not done

- Hosts file. `http://app.urmiai.local` and `http://store.urmiai.local` do not resolve from this Windows account. The working URLs are `http://127.0.0.1:18080` for the dashboard and `http://127.0.0.1` with `Host: store.urmiai.local` for the shop. An Administrator can add both names to `C:\Windows\System32\drivers\etc\hosts` pointing at `127.0.0.1`.
- No LLM key. Chat is wired (SSE, the logged-in user, the same `callAggregatedTool` path) and stops with a clear error. It will not call tools until `LLM_API_KEY` is set.
- No third public MCP server. The two in-cluster upstreams are WooCommerce and notes. `docs/third-upstream.md` is the note for adding a public one.
- No click-through checkout in a browser. The shop HTML lists the mug and an Add to cart control, and order 13 was created as cash on delivery, but the browser cannot follow `store.urmiai.local` until the hosts line exists.
- `docs/system-design-tradeoffs.md`, `docs/threat-model.md`, and the demo video are still unwritten. Those are separate from this run.
