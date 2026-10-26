# Interview Prep

For every decision an interviewer will push on: the answer in a few sentences, then the follow-up they ask next. Practice saying these out loud.

## "Walk me through a tool call."

1. The client sends `POST /mcp` with `Authorization: Bearer <api key>` and a `tools/call` for `woocommerce__list_orders`.
2. `requireApiKey` hashes nothing up front — it looks up candidate rows by the 8-character prefix, then argon2-verifies. A revoked key has `revoked_at` set, so the query excludes it and this returns 401.
3. The gateway splits the name on the first `__`, giving server `woocommerce` and tool `list_orders`, and loads that row.
4. `getClient` decrypts the stored credential with `GATEWAY_KEK` and attaches it as the upstream's header or bearer. The decrypted value is a local variable. It is never logged and never put in a response.
5. The call goes out through the pooled MCP client with a 15-second timeout.
6. The WooCommerce MCP server calls the WordPress REST API and returns the orders.
7. `writeAuditLog` inserts one row in a `finally`-equivalent position — it runs for both success and failure — with the user, server, tool, duration, and outcome.
8. The gateway returns the MCP result.

**Follow-up: "What if step 5 hangs?"** `withTimeout` rejects at the deadline, the client is evicted from the pool so the next call reconnects fresh, the audit row records `timeout`, and the caller gets an MCP error that names the server. Other upstreams are unaffected because each call is its own promise.

## "How does tool listing survive a dead server?"

`listAggregatedTools` uses `Promise.allSettled`, not `Promise.all`. A rejected or timed-out upstream becomes an entry in `failures` and contributes zero tools. The rest are returned. One dead server cannot fail the batch.

## "Two servers expose a tool with the same name."

Every tool is renamed to `<slug>__<tool>` when it is aggregated. The slug is validated to `[a-z0-9-]{2,40}` and is unique in the table. On a call, the gateway splits on the first `__` and routes by slug. I chose `__` because it is valid in every client tool-name grammar I checked and stays readable.

## "Why hash API keys but encrypt upstream credentials?"

Different jobs. An API key only needs to be checked, so a one-way argon2id hash is right and a leak of the database does not reveal keys. An upstream credential has to be sent on every call, so it must be reversible: AES-256-GCM with a key that lives in a Kubernetes Secret and nowhere in the database. Say this distinction explicitly — it is the question they use to see if you understand the difference.

## "What can a member do with an upstream credential they never see?"

Only what that credential can do upstream. The WooCommerce key the init job creates has `read_write` scope on the REST API and nothing else on the WordPress site. The gateway routes and audits. It does not widen what the credential can reach. So the real boundary is the credential's own scope, and it is worth saying that the gateway is not the security boundary for the store.

## "Why can't anyone outside the cluster reach the WooCommerce MCP server?"

Its Service is `ClusterIP` and no Ingress names it. There is no routable path from outside the cluster. The dashboard nginx proxies `/mcp` to the gateway, not to the upstreams.

## "Why do the chat agent's calls show up under the right user?"

Registration creates a primary API key for each user, and the chat endpoint authenticates with the dashboard JWT, which carries the user id. `runChatTurn` calls the same `callAggregatedTool` and `writeAuditLog` that an external client hits, passing that user id. There is no separate system identity, so the audit log cannot tell the two apart — which is the point.

## "Why Helm, and why one umbrella chart?"

The assignment requires Helm. One chart with subcharts means `values-local.yaml` and `values-prod.yaml` are the only difference between a laptop and a VPS: domain, storage class, TLS, replica count. I put those under `global` for a specific reason — Helm only propagates the `global` key from a parent chart down into subcharts, so a value set anywhere else at the parent level is silently ignored. That is an easy thing to get wrong and a good thing to mention.

## "What stops an admin adding a malicious URL?"

`assertUrlAllowed` resolves the host and rejects loopback, link-local, and the cloud metadata address `169.254.169.254`. It also rejects private ranges unless `ALLOW_INTERNAL_UPSTREAMS=true`, which is set only in local values because our own upstreams are cluster DNS names. Be honest that this is a tension: local dev needs internal URLs and SSRF defense blocks them, and the flag is the explicit resolution rather than turning the check off.

## "What happens when I kill the WooCommerce MCP pod?"

The gateway's health loop fails its next `tools/list` ping, sets that server's status to `unreachable` within one interval, and the dashboard badge flips. Tool listing omits its tools. The other servers keep working. Kubernetes restarts the pod, and the next successful ping flips it back to `connected`.

## "How does the gateway pick up a newly added or disabled server without a restart?"

The MCP SDK serves `tools/list` and `tools/call` from an internal map built at registration time. I register one placeholder, `gateway_status`, so the SDK installs those handlers, then I replace both. The list handler asks the aggregator on every request. The call handler does not look the tool up in that map. It splits the name on the first `__` and forwards it. Stuffing tools into the private map is what I tried first. `tools/list` worked and `tools/call` then failed inside the SDK, so the call handler has to be replaced too. Disabling a server takes effect on the next request, with no reconnect and no restart.

## "Why OpenAI, and why is there still no provider SDK?"

The chat loop only POSTs `/chat/completions` with tools. The local default is OpenAI at `https://api.openai.com/v1`, model `gpt-4.1-mini`, with the platform key sent as a Bearer token. That is the shape the loop was written for, so there is no OpenAI SDK. Gemini and Groq stay a three-line swap of `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. Gemini's native `generateContent` API is a different shape, so it is not a second client. `gemini-3.8-flash` returned 503 under load and `gemini-2.5-flash` returns 404 for new keys, which is why chat moved off Gemini.

Gemini 3 also returns `extra_content.google.thought_signature` on each function call and rejects the next round with 400 if that object is missing. The loop keeps the object on the assistant message and sends it back unchanged. It is not logged and it is not shown in the chat UI. A provider that does not send it is unaffected, because the field is only added when it was present.

The chat panel does not print that tool body. A WooCommerce order payload is the entire REST object, and pasting it pushes the model's sentence off the screen. `ChatPage` shows one line per call (`#31 Luis Ortega — processing, $42.00 (1× Pour-Over Kettle)`). A list of orders is several of those lines joined together, not the REST body. The bytes sent back to the model are unchanged.

## "Why isn't a failed tool call just text inside a successful result?"

The MCP SDK reports a bad tool call as a normal JSON-RPC response with `isError: true` on the result. If the gateway treated that as success, the audit log would say the call worked and a client would not see an error flag. `callAggregatedTool` reads that flag and returns `upstream_error`, which is what gets audited and what the gateway's own `tools/call` marks `isError`. A duplicate server slug is the same idea on the REST side: Postgres raises unique-violation `23505`, and the route turns that into 409 instead of letting the rejection kill the process.

## "Why is the demo catalog not in the Helm chart?"

`deploy/seed-demo.php` writes five products and three cash-on-delivery orders into WooCommerce, and drafts the timestamped test products from earlier runs. The chart stays the same for an empty store and for the video. Putting fixture rows in SQL or in values would special-case an environment, which the chart is not supposed to do. The notes server starts with three lines in memory for the same reason: a restart should still have something to list, and nothing there is the system of record.

## Things to confirm before the demo

- [ ] Which public server you registered as the third upstream, and that it was actually up (see `docs/third-upstream.md`).
- [ ] The LLM key works. Free tiers get rate-limited; test it the day before.
- [ ] You have run the definition-of-done flow once with two real users and can narrate it.
- [ ] You can explain, without looking, why the REST key lives in a file on the shared volume instead of a Secret created by the init job.
