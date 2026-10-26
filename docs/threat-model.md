# Threat model

What the gateway actually enforces. Where a control was not built, this note says so.

## Shared upstream credentials

An admin registers an upstream once. If it needs a token, `encryptCredential` stores AES-256-GCM ciphertext, IV, and auth tag. `GET /api/servers` does not select those columns, and no route returns the plaintext.

A member never sees that credential. They can still call every tool on every enabled server, through `/mcp` with their own gateway key or through chat. The gateway decrypts the credential inside `getClient` and attaches it only on the outbound request to that server.

For WooCommerce, the init job creates a REST key with read/write scope on products and orders. The gateway does not narrow that. A member who calls `woocommerce__create_product` or `woocommerce__update_order_status` is using that shared key. The audit row shows the member, not the credential. Per-user tool permissions (read orders, but not change them) were not built. The boundary is the upstream credential's own scope, plus "only an admin can point us at a different credential."

## Why client tokens are not passed through

Two credentials, two directions.

The dashboard session is a JWT (`JWT_SECRET`, 12 hours). An external MCP client sends `Authorization: Bearer urmiai_...`. `requireApiKey` checks the argon2id hash and then keeps only the user id. `getClient` never copies that header onto the upstream request. It sets `Authorization` or the configured header from the decrypted upstream credential, or it sets nothing when `authType` is `none`.

Chat does not present the user's API key either. `POST /api/chat` checks the JWT and `runChatTurn` calls `callAggregatedTool` in-process with that user id. A hidden `chat-agent` key is created at registration so the user has a gateway key; the raw value is discarded and the chat path does not send it.

A leaked `urmiai_` key can call the gateway until it is revoked. It is not a WooCommerce secret. A leaked WooCommerce key can call the store REST API. It is not a dashboard login and not another user's gateway key. The database stores only the argon2 hash of the gateway key, so a dump of `api_keys` does not replay the client token. Replaying the upstream token still requires `GATEWAY_KEK` from the Kubernetes Secret.

## Untrusted upstreams

Tool descriptions and input schemas are copied into the aggregated list and, for chat, into the model's tool list unchanged. There is no filter for instructions hidden in a description. A compromised server can write a description that tells the model to call a tool, and the model may do it. The tool result is also untrusted text and is sent back to the model.

What limits that:

- Only an admin can add, disable, or remove a server (`requireAdmin` on those routes, not only a hidden button).
- `assertUrlAllowed` rejects non-http(s) URLs, `localhost`, loopback, link-local, and `169.254.169.254`. Private ranges are rejected unless `ALLOW_INTERNAL_UPSTREAMS=true`.
- A call runs only if a client or the model invokes that tool. Chat stops after 5 tool rounds.
- The system prompt tells the model not to invent data. It does not make a malicious description safe.
- Every call is audited under the user who was logged in. Disable drops that server's tools on the next list.
- The upstream receives only its own credential. It is not given `GATEWAY_KEK`, the JWT secret, or another server's ciphertext.

A member cannot register the malicious server. An admin can, and the blast radius is the tools that server exposes, run as whichever user is chatting or calling, plus whatever text the model trusts. The gateway does not sandbox tool output.

## What one team member can do to another

| | Member | Admin |
|---|---|---|
| Call enabled tools, including writes on the shared store | yes | yes |
| See or revoke another user's API keys | no. List and revoke are `WHERE user_id = caller`. | no. There is no cross-user key API. |
| See another user's audit rows | no. `GET /api/audit` filters to the caller. | yes, all rows |
| Add, disable, or remove a server | 403 | yes |
| Change another user's role or password | no such route | no such route. The first registered user is admin. Later users are members. |

The cross-user effect that does exist is the shared store. One member's `update_order_status` changes the order the other member lists. Notes are one in-memory list, so one member's `add_note` is visible to the other. That is the shared credential, not a leaked key.

Revoking a key makes the next `/mcp` call return `Invalid or revoked API key`. It does not log the other user out of the dashboard. Their JWT stays valid until it expires.
