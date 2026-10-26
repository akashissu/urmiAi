import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dash = "http://127.0.0.1:18080";
const gateway = "http://127.0.0.1:18082";
const notesDirect = "http://127.0.0.1:18083";
const wooDirect = "http://127.0.0.1:18084";
const out = [];
const log = (step, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  " + detail : ""}`;
  out.push(line);
  console.log(line);
};

async function api(base, path, { method = "GET", token, body, raw } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  if (!raw) {
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
  }
  return { status: response.status, json, text, headers: response.headers };
}

function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function kubectlPhp(php) {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["exec", "-i", "-n", "platform", "deploy/wordpress", "--", "php"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout).slice(0, 400)))));
    child.stdin.end(php);
  });
}

function unwrap(result) {
  const text = result?.content?.[0]?.text ?? "";
  const once = JSON.parse(text);
  const inner = once?.content?.[0]?.text;
  return typeof inner === "string" ? JSON.parse(inner) : once;
}

async function connect(url, key) {
  const client = new Client({ name: "manual", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : {},
  });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

const openClients = [];
const stamp = Date.now();
const memberEmail = `manual-member-${stamp}@example.com`;
const password = "password123";
let adminToken = "";
let memberToken = "";
let servers = [];
let notesId = "";
let wooId = "";
let adminKey = "";
let adminKeyId = "";
let memberKey = "";
let tempServerId = "";
let product = null;
let orderId = 0;

try {
  const live = await api(gateway, "/livez");
  log("gateway livez", live.status === 200 && live.json?.ok === true, `status ${live.status}`);
  const health = await api(gateway, "/healthz");
  log("gateway healthz (postgres)", health.status === 200 && health.json?.ok === true, `status ${health.status}`);
  const notesHealth = await api(notesDirect, "/healthz");
  log("notes-mcp healthz", notesHealth.status === 200 && notesHealth.json?.ok === true, `status ${notesHealth.status}`);
  const wooHealth = await api(wooDirect, "/healthz");
  log("woocommerce-mcp healthz", wooHealth.status === 200 && wooHealth.json?.ok === true, `status ${wooHealth.status}`);

  const spa = await api(dash, "/", { raw: true });
  log("dashboard serves the app", spa.status === 200 && spa.text.includes("UrmiAi"), `status ${spa.status}`);
  const dashHealthIsSpa = await api(dash, "/healthz", { raw: true });
  log(
    "dashboard /healthz is the SPA, probes hit the gateway",
    dashHealthIsSpa.status === 200 && dashHealthIsSpa.text.includes("<html"),
    "nginx try_files",
  );

  const noAuth = await api(dash, "/api/auth/me");
  log("me without a token is rejected", noAuth.status === 401, `status ${noAuth.status}`);
  const badLogin = await api(dash, "/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "wrong-password" } });
  log("wrong password rejected", badLogin.status === 401 && badLogin.json?.error === "Invalid email or password", badLogin.json?.error);
  const unknownLogin = await api(dash, "/api/auth/login", { method: "POST", body: { email: "nobody@example.com", password: "password123" } });
  log("unknown email uses the same error", unknownLogin.status === 401 && unknownLogin.json?.error === badLogin.json?.error, unknownLogin.json?.error);
  const shortPw = await api(dash, "/api/auth/register", { method: "POST", body: { email: memberEmail, password: "short" } });
  log("short password rejected", shortPw.status === 400, `status ${shortPw.status} ${shortPw.json?.error}`);

  const login = await api(dash, "/api/auth/login", { method: "POST", body: { email: "admin@example.com", password } });
  adminToken = login.json?.token;
  log("admin login", login.status === 200 && login.json?.user?.role === "admin", `role ${login.json?.user?.role}`);
  const me = await api(dash, "/api/auth/me", { token: adminToken });
  log("me matches the login", me.status === 200 && me.json?.email === "admin@example.com" && me.json?.role === "admin", `${me.json?.email} ${me.json?.role}`);

  const registered = await api(dash, "/api/auth/register", { method: "POST", body: { email: memberEmail, password } });
  memberToken = registered.json?.token;
  log("second account is a member", registered.status === 201 && registered.json?.user?.role === "member", memberEmail);
  const duplicate = await api(dash, "/api/auth/register", { method: "POST", body: { email: memberEmail, password } });
  log("duplicate email rejected", duplicate.status === 409, `status ${duplicate.status}`);
  const memberLogin = await api(dash, "/api/auth/login", { method: "POST", body: { email: memberEmail, password } });
  log("member can log in", memberLogin.status === 200 && memberLogin.json?.user?.role === "member", `status ${memberLogin.status}`);

  const keys = await api(dash, "/api/keys", { token: adminToken });
  const keyBlob = JSON.stringify(keys.json);
  const primary = (keys.json ?? []).find((key) => key.isPrimary && key.label === "chat-agent");
  log("key list hides the raw key and the hash", keys.status === 200 && !keyBlob.includes("rawKey") && !keyBlob.includes("key_hash") && !keyBlob.includes("keyHash"), `${(keys.json ?? []).length} keys`);
  log("admin has a primary chat-agent key", Boolean(primary) && primary.revokedAt == null, primary ? primary.keyPrefix : "missing");

  const issued = await api(dash, "/api/keys", { method: "POST", token: adminToken, body: { label: "manual" } });
  adminKey = issued.json?.rawKey;
  adminKeyId = issued.json?.id;
  log("issuing a key returns it once", issued.status === 201 && adminKey?.startsWith("urmiai_") && adminKey.startsWith(issued.json?.keyPrefix), issued.json?.keyPrefix);
  const keysAfter = await api(dash, "/api/keys", { token: adminToken });
  log("the raw key is not in the list", !JSON.stringify(keysAfter.json).includes(adminKey), "list re-fetched");

  const memberIssued = await api(dash, "/api/keys", { method: "POST", token: memberToken, body: { label: "manual-member" } });
  memberKey = memberIssued.json?.rawKey;
  log("member can issue their own key", memberIssued.status === 201 && memberKey?.startsWith("urmiai_"), memberIssued.json?.keyPrefix);
  const steal = await api(dash, `/api/keys/${adminKeyId}/revoke`, { method: "POST", token: memberToken });
  log("member cannot revoke the admin key", steal.status === 404, `status ${steal.status}`);

  const mcpNoKey = await api(dash, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  log("mcp without a key is rejected", mcpNoKey.status === 401, `status ${mcpNoKey.status} ${mcpNoKey.text?.slice(0, 80)}`);
  const mcpBadKey = await api(dash, "/mcp", { method: "POST", token: "urmiai_not-a-real-key", body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  log("mcp with a fake key is rejected", mcpBadKey.status === 401, `status ${mcpBadKey.status}`);

  const directNotes = await connect(`${notesDirect}/mcp`);
  const directNoteTools = (await directNotes.listTools()).tools.map((tool) => tool.name);
  log("notes server directly lists its tools", directNoteTools.includes("add_note") && directNoteTools.includes("list_notes"), directNoteTools.join(", "));
  await directNotes.close();

  const directWoo = await connect(`${wooDirect}/mcp`);
  const directWooTools = (await directWoo.listTools()).tools.map((tool) => tool.name);
  log(
    "woocommerce server directly lists its five tools",
    ["list_products", "create_product", "list_orders", "get_order", "update_order_status"].every((name) => directWooTools.includes(name)),
    directWooTools.join(", "),
  );
  await directWoo.close();

  const client = await connect(`${dash}/mcp`, adminKey);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  log(
    "gateway tools/list prefixes both servers",
    names.includes("gateway_status") && names.includes("woocommerce__create_product") && names.includes("notes__add_note") && names.includes("woocommerce__update_order_status"),
    names.join(", "),
  );
  const sameViaGatewayPort = await connect(`${gateway}/mcp`, adminKey);
  const viaGateway = (await sameViaGatewayPort.listTools()).tools.map((tool) => tool.name).sort().join(",");
  log("dashboard /mcp and gateway /mcp return the same tools", viaGateway === [...names].sort().join(","), `${names.length} tools`);
  await sameViaGatewayPort.close();

  const status = unwrap(await client.callTool({ name: "gateway_status", arguments: {} }));
  log("gateway_status reports both upstreams", status.toolCount === names.length - 1 && Array.isArray(status.failures) && status.failures.length === 0, JSON.stringify(status));

  const productName = `Manual Mug ${stamp}`;
  const sku = `MUG-${stamp}`;
  const created = unwrap(await client.callTool({
    name: "woocommerce__create_product",
    arguments: { name: productName, regularPrice: "24.50", description: "Manual test mug", sku, stockQuantity: 7 },
  }));
  product = created;
  log(
    "create_product stores name, price, sku, stock",
    created.name === productName && created.regular_price === "24.50" && created.sku === sku && created.stock_quantity === 7,
    `id ${created.id} sku ${created.sku} stock ${created.stock_quantity}`,
  );
  const found = unwrap(await client.callTool({ name: "woocommerce__list_products", arguments: { search: productName, perPage: 5 } }));
  log("list_products search finds it", Array.isArray(found) && found.some((item) => item.id === created.id), `count ${found.length}`);

  const orderJson = JSON.parse(await kubectlPhp(`<?php
require "/var/www/html/wp-load.php";
$found = wc_get_products(["sku" => ${JSON.stringify(sku)}, "limit" => 1]);
if (empty($found)) { fwrite(STDERR, "no product\\n"); exit(1); }
$order = wc_create_order();
$order->add_product($found[0], 2);
$order->set_payment_method("cod");
$order->set_payment_method_title("Cash on delivery");
$order->set_address(["first_name" => "Manual", "last_name" => "Buyer", "city" => "Pune", "country" => "IN", "email" => "manual-buyer@example.com"], "billing");
$order->calculate_totals();
$order->update_status("processing", "manual e2e");
echo json_encode(["id" => $order->get_id(), "status" => $order->get_status(), "total" => $order->get_total()]);
`));
  orderId = orderJson.id;
  log("store checkout creates a COD order", orderJson.status === "processing" && Number(orderJson.total) === 49, `order ${orderId} total ${orderJson.total}`);

  const orders = unwrap(await client.callTool({ name: "woocommerce__list_orders", arguments: { status: "processing", perPage: 20 } }));
  log("list_orders status=processing includes it", Array.isArray(orders) && orders.some((order) => order.id === orderId), `count ${orders.length}`);
  const order = unwrap(await client.callTool({ name: "woocommerce__get_order", arguments: { orderId } }));
  log("get_order returns the buyer and two mugs", order.id === orderId && order.billing?.email === "manual-buyer@example.com" && order.line_items?.[0]?.quantity === 2, `status ${order.status} qty ${order.line_items?.[0]?.quantity}`);
  const held = unwrap(await client.callTool({ name: "woocommerce__update_order_status", arguments: { orderId, status: "on-hold" } }));
  log("update_order_status to on-hold", held.status === "on-hold", held.status);
  const done = unwrap(await client.callTool({ name: "woocommerce__update_order_status", arguments: { orderId, status: "completed" } }));
  log("update_order_status to completed", done.status === "completed", done.status);
  const missing = await client.callTool({ name: "woocommerce__get_order", arguments: { orderId: 999999 } });
  log("get_order on a missing id is an error", missing.isError === true, JSON.stringify(missing).slice(0, 180));
  const badStatus = await client.callTool({ name: "woocommerce__update_order_status", arguments: { orderId, status: "shipped" } });
  log("update_order_status rejects an unknown status", badStatus.isError === true, JSON.stringify(badStatus).slice(0, 180));

  const noteText = `manual note ${stamp}`;
  const note = unwrap(await client.callTool({ name: "notes__add_note", arguments: { text: noteText } }));
  log("notes__add_note returns the saved note", note.text === noteText && Boolean(note.id), note.id);
  const notes = unwrap(await client.callTool({ name: "notes__list_notes", arguments: {} }));
  log("notes__list_notes returns it newest first", Array.isArray(notes) && notes[0]?.text === noteText, `count ${notes.length}`);
  const emptyNote = await client.callTool({ name: "notes__add_note", arguments: { text: "" } });
  log("notes__add_note rejects an empty note", emptyNote.isError === true, JSON.stringify(emptyNote).slice(0, 160));

  const unknown = await client.callTool({ name: "woocommerce__does_not_exist", arguments: {} });
  log("unknown upstream tool is an error", unknown.isError === true, JSON.stringify(unknown).slice(0, 180));
  const noServer = await client.callTool({ name: "missing__list_products", arguments: {} });
  log("unknown server prefix is an error", noServer.isError === true && JSON.stringify(noServer).includes("missing"), JSON.stringify(noServer).slice(0, 180));

  servers = (await api(dash, "/api/servers", { token: adminToken })).json ?? [];
  notesId = servers.find((server) => server.slug === "notes")?.id;
  wooId = servers.find((server) => server.slug === "woocommerce")?.id;
  const serverBlob = JSON.stringify(servers);
  log("server list has both and no credential columns", Boolean(notesId) && Boolean(wooId) && !serverBlob.includes("credential") && !serverBlob.includes("ciphertext"), servers.map((server) => `${server.slug}:${server.status}`).join(", "));

  const wooTools = await api(dash, `/api/servers/${wooId}/tools`, { token: adminToken });
  log("per-server tools for woocommerce", wooTools.status === 200 && wooTools.json.some((tool) => tool.name === "create_product"), (wooTools.json ?? []).map((tool) => tool.name).join(", "));
  const noteTools = await api(dash, `/api/servers/${notesId}/tools`, { token: memberToken });
  log("a member can read a server's tools", noteTools.status === 200 && noteTools.json.some((tool) => tool.name === "add_note"), `status ${noteTools.status}`);

  const memberAdd = await api(dash, "/api/servers", { method: "POST", token: memberToken, body: { slug: "nope", name: "Nope", baseUrl: "https://example.com/mcp" } });
  log("member cannot register a server", memberAdd.status === 403, `status ${memberAdd.status}`);
  const badSlug = await api(dash, "/api/servers", { method: "POST", token: adminToken, body: { slug: "Bad Slug", name: "Bad", baseUrl: "https://example.com/mcp" } });
  log("slug must be lowercase", badSlug.status === 400, badSlug.json?.error);
  const loopback = await api(dash, "/api/servers", { method: "POST", token: adminToken, body: { slug: "loopback", name: "Loop", baseUrl: "http://127.0.0.1:9/mcp" } });
  log("ssrf guard blocks loopback", loopback.status === 400 && /blocked/i.test(loopback.json?.error ?? ""), loopback.json?.error);
  const metadata = await api(dash, "/api/servers", { method: "POST", token: adminToken, body: { slug: "metadata", name: "Meta", baseUrl: "http://169.254.169.254/latest/meta-data" } });
  log("ssrf guard blocks the metadata address", metadata.status === 400 && /blocked/i.test(metadata.json?.error ?? ""), metadata.json?.error);

  const leftover = servers.find((server) => server.slug === "manualtemp");
  if (leftover) await api(dash, `/api/servers/${leftover.id}`, { method: "DELETE", token: adminToken });

  const temp = await api(dash, "/api/servers", {
    method: "POST",
    token: adminToken,
    body: { slug: "manualtemp", name: "Manual Temp", baseUrl: "https://example.com/mcp", authType: "bearer", credential: "super-secret-token" },
  });
  tempServerId = temp.json?.id;
  log("admin can register a server with a bearer credential", temp.status === 201 && temp.json?.slug === "manualtemp" && !JSON.stringify(temp.json).includes("super-secret-token"), `status ${temp.status}`);
  const afterAdd = await api(dash, "/api/servers", { token: adminToken });
  log("credential is never returned on the list", !JSON.stringify(afterAdd.json).includes("super-secret-token"), `count ${(afterAdd.json ?? []).length}`);
  const tempTools = await api(dash, `/api/servers/${tempServerId}/tools`, { token: adminToken });
  log("an unreachable new server returns 502, not a bare 500", tempTools.status === 502 && /manualtemp/.test(tempTools.json?.error ?? ""), tempTools.json?.error?.slice(0, 140));
  const duplicateSlug = await api(dash, "/api/servers", { method: "POST", token: adminToken, body: { slug: "manualtemp", name: "Again", baseUrl: "https://example.com/mcp" } });
  log("duplicate slug is rejected", duplicateSlug.status >= 400 && duplicateSlug.status < 500, `status ${duplicateSlug.status} ${duplicateSlug.json?.error ?? String(duplicateSlug.text).slice(0, 120)}`);
  const patched = await api(dash, `/api/servers/${tempServerId}`, { method: "PATCH", token: adminToken, body: { name: "Renamed" } });
  log("PATCH /api/servers/:id is not implemented", patched.status === 404, `status ${patched.status}`);

  await client.listTools();
  const withTemp = (await client.listTools()).tools.map((tool) => tool.name);
  log("gateway list still works when one upstream is down", withTemp.includes("notes__add_note") && withTemp.includes("woocommerce__list_products"), withTemp.filter((name) => !name.startsWith("manualtemp")).join(", "));

  await api(dash, `/api/servers/${notesId}/disable`, { method: "POST", token: adminToken });
  const hidden = (await client.listTools()).tools.map((tool) => tool.name);
  log("disabling notes hides its tools immediately", !hidden.some((name) => name.startsWith("notes__")) && hidden.some((name) => name.startsWith("woocommerce__")), hidden.join(", "));
  const disabledCall = await client.callTool({ name: "notes__list_notes", arguments: {} });
  log("calling a disabled server names the reason", disabledCall.isError === true && JSON.stringify(disabledCall).includes("disabled"), JSON.stringify(disabledCall).slice(0, 180));
  const memberDisable = await api(dash, `/api/servers/${wooId}/disable`, { method: "POST", token: memberToken });
  log("member cannot disable woocommerce", memberDisable.status === 403, `status ${memberDisable.status}`);
  await api(dash, `/api/servers/${notesId}/enable`, { method: "POST", token: adminToken });
  const restored = (await client.listTools()).tools.map((tool) => tool.name);
  log("enabling notes restores its tools", restored.includes("notes__list_notes"), "notes__list_notes present");

  const memberClient = await connect(`${dash}/mcp`, memberKey);
  const memberNote = unwrap(await memberClient.callTool({ name: "notes__add_note", arguments: { text: `member note ${stamp}` } }));
  log("member key calls a tool as that member", memberNote.text === `member note ${stamp}`, memberNote.id);
  await memberClient.close();

  const audit = await api(dash, "/api/audit?limit=30", { token: adminToken });
  const rows = audit.json ?? [];
  const sawProduct = rows.some((row) => row.tool_name === "woocommerce__create_product" && row.success && row.user_email === "admin@example.com");
  const sawDisabled = rows.some((row) => row.tool_name === "notes__list_notes" && row.success === false && /disabled/i.test(row.error_message ?? ""));
  const sawMember = rows.some((row) => row.tool_name === "notes__add_note" && row.user_email === memberEmail && row.success);
  const sawStatus = rows.some((row) => row.tool_name === "gateway_status");
  log("audit records the admin product create", audit.status === 200 && sawProduct, `${rows.length} rows`);
  log("audit records the disabled-server failure", sawDisabled, sawDisabled ? "found" : "missing");
  log("audit attributes the member call to the member", sawMember, memberEmail);
  log("gateway_status is not written to the audit log", !sawStatus, "absent from the latest 30");

  const memberAudit = await api(dash, "/api/audit?limit=50", { token: memberToken });
  const memberRows = Array.isArray(memberAudit.json) ? memberAudit.json : [];
  log(
    "member audit is only their own rows",
    memberAudit.status === 200 && memberRows.length > 0 && memberRows.every((row) => row.user_email === memberEmail),
    memberRows.map((row) => row.tool_name).join(", "),
  );
  const filtered = await api(dash, "/api/audit?limit=20&serverSlug=notes", { token: adminToken });
  const filterIgnored = (filtered.json ?? []).some((row) => row.server_slug && row.server_slug !== "notes");
  log("audit serverSlug query is ignored (not implemented)", filterIgnored, "build plan lists it; the handler only applies limit");

  const used = await api(dash, "/api/keys", { token: adminToken });
  const manualKey = (used.json ?? []).find((key) => key.id === adminKeyId);
  log("using a key stamps lastUsedAt", Boolean(manualKey?.lastUsedAt), manualKey?.lastUsedAt ?? "null");

  await api(dash, `/api/keys/${adminKeyId}/revoke`, { method: "POST", token: adminToken });
  let revokedRejected = false;
  try {
    const revoked = await connect(`${dash}/mcp`, adminKey);
    await revoked.listTools();
    await revoked.close();
  } catch (err) {
    revokedRejected = /revoked|Invalid/i.test(err instanceof Error ? err.message : String(err));
    log("revoked key is rejected", revokedRejected, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }
  if (!revokedRejected) log("revoked key is rejected", false, "call succeeded");
  const again = await api(dash, `/api/keys/${adminKeyId}/revoke`, { method: "POST", token: adminToken });
  log("revoking twice returns 404", again.status === 404, `status ${again.status}`);

  const chat = await api(dash, "/api/chat", {
    method: "POST",
    token: adminToken,
    raw: true,
    body: { messages: [{ role: "user", content: "Use the woocommerce list_orders tool for status completed and tell me how many orders came back. Do not invent a number." }] },
  });
  const chatFlat = chat.text.replaceAll("\n", " | ");
  const chatCalledTool = chat.text.includes("event: tool_call") && chat.text.includes("woocommerce__list_orders");
  const chatAnswered = chat.text.includes("event: message") || chat.text.includes("event: tool_result");
  log(
    "chat calls a tool and finishes",
    chat.status === 200 && chat.headers.get("content-type")?.includes("text/event-stream") && chat.text.includes("event: done") && chatCalledTool && chatAnswered && !chat.text.includes("LLM_API_KEY is not configured"),
    chatFlat.slice(0, 320),
  );
  const chatAudit = await api(dash, "/api/audit?limit=10", { token: adminToken });
  const chatRow = (chatAudit.json ?? []).find((row) => row.tool_name === "woocommerce__list_orders" && row.user_email === "admin@example.com");
  log("chat tool call is audited as the logged-in user", Boolean(chatRow), chatRow ? `${chatRow.success} ${chatRow.duration_ms}ms` : "no row");
  const badChat = await api(dash, "/api/chat", { method: "POST", token: adminToken, body: { messages: [{ role: "system", content: "nope" }] } });
  log("chat rejects a bad message role", badChat.status === 400, `status ${badChat.status}`);
  const chatNoAuth = await api(dash, "/api/chat", { method: "POST", body: { messages: [] } });
  log("chat without a token is rejected", chatNoAuth.status === 401, `status ${chatNoAuth.status}`);

  const namedShop = await fetch("http://store.urmiai.local/shop/");
  const namedHtml = await namedShop.text();
  log("http://store.urmiai.local/shop/ resolves", namedShop.status === 200 && namedHtml.includes(productName), `status ${namedShop.status}`);

  const shop = await httpGet(80, "/shop/", { Host: "store.urmiai.local" });
  const productPage = await httpGet(80, `/product/${product.slug}/`, { Host: "store.urmiai.local" });
  const cart = await httpGet(80, "/cart/", { Host: "store.urmiai.local" });
  const checkout = await httpGet(80, "/checkout/", { Host: "store.urmiai.local" });
  const account = await httpGet(80, "/my-account/", { Host: "store.urmiai.local" });
  const wpJson = await httpGet(80, "/wp-json/", { Host: "store.urmiai.local" });
  const restDenied = await httpGet(80, "/wp-json/wc/v3/products", { Host: "store.urmiai.local" });
  const app = await httpGet(80, "/", { Host: "app.urmiai.local" });
  log("shop lists the new product", shop.status === 200 && shop.body.includes(productName), `status ${shop.status}`);
  log("product page is public", productPage.status === 200 && productPage.body.includes(productName) && productPage.body.includes("24.50"), `status ${productPage.status}`);
  log("cart page loads", cart.status === 200 && /cart/i.test(cart.body), `status ${cart.status}`);
  const added = await httpGet(80, `/?add-to-cart=${product.id}`, { Host: "store.urmiai.local" });
  const cookie = []
    .concat(added.headers["set-cookie"] ?? [])
    .map((value) => String(value).split(";")[0])
    .join("; ");
  const checkoutWithItem = await httpGet(80, "/checkout/", { Host: "store.urmiai.local", Cookie: cookie });
  log(
    "checkout with the new product shows cash on delivery",
    checkoutWithItem.status === 200 && checkoutWithItem.body.includes("wc-payment-method-cod") && checkoutWithItem.body.includes(productName),
    `empty ${checkout.status} with-item ${checkoutWithItem.status}`,
  );
  log("my account page loads", account.status === 200, `status ${account.status}`);
  log("wp-json is JSON, not the theme", wpJson.status === 200 && wpJson.body.trim().startsWith("{"), wpJson.body.slice(0, 40));
  log("woocommerce REST without a key is 401 JSON", restDenied.status === 401 && restDenied.body.includes("woocommerce_rest"), `status ${restDenied.status}`);
  log("ingress routes app.urmiai.local to the dashboard", app.status === 200 && app.body.includes("UrmiAi"), `status ${app.status}`);

  const removed = await api(dash, `/api/servers/${tempServerId}`, { method: "DELETE", token: adminToken });
  if (removed.status === 204) tempServerId = "";
  log("admin can remove the temporary server", removed.status === 204, `status ${removed.status}`);
  const gone = await api(dash, `/api/servers/${temp.json?.id ?? "missing"}`, { method: "DELETE", token: adminToken });
  log("removing it again is 404", gone.status === 404, `status ${gone.status}`);

  await client.close();
} catch (err) {
  log("script aborted", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  if (notesId && adminToken) await api(dash, `/api/servers/${notesId}/enable`, { method: "POST", token: adminToken }).catch(() => {});
  if (tempServerId && adminToken) await api(dash, `/api/servers/${tempServerId}`, { method: "DELETE", token: adminToken }).catch(() => {});
  await Promise.all(openClients.map((client) => client.close().catch(() => {})));
}

console.log("\n---SUMMARY---");
const fails = out.filter((line) => line.startsWith("FAIL"));
console.log(`${out.length - fails.length}/${out.length} passed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exitCode = 1;
} else {
  console.log("ALL_PASS");
}
console.log(`MEMBER ${memberEmail}`);
