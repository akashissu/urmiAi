import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = "http://127.0.0.1:18080";
const out = [];
const log = (step, ok, detail) => {
  const line = `${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`;
  out.push(line);
  console.log(line);
};

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function httpGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function kubectlPhp(php) {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["exec", "-i", "-n", "platform", "deploy/wordpress", "--", "php"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error((err || out).slice(0, 400)));
      else resolve(out.trim());
    });
    child.stdin.end(php);
  });
}

function unwrapTool(result) {
  const text = result?.content?.[0]?.text ?? "";
  const once = JSON.parse(text);
  const inner = once?.content?.[0]?.text;
  return typeof inner === "string" ? JSON.parse(inner) : once;
}

const login = await api("/api/auth/login", {
  method: "POST",
  body: { email: "admin@example.com", password: "password123" },
});
const token = login.json?.token;
log("login", login.status === 200 && login.json?.user?.role === "admin", `status ${login.status} role ${login.json?.user?.role}`);

const servers = await api("/api/servers", { token });
const bySlug = Object.fromEntries((servers.json ?? []).map((server) => [server.slug, server]));
log(
  "servers registered",
  servers.status === 200 && bySlug.woocommerce && bySlug.notes,
  (servers.json ?? []).map((server) => `${server.slug}:${server.status}`).join(", "),
);

for (const slug of ["woocommerce", "notes"]) {
  const tools = await api(`/api/servers/${bySlug[slug].id}/tools`, { token });
  const names = (tools.json ?? []).map((tool) => tool.name);
  log(`${slug} tools`, tools.status === 200 && names.length > 0, names.join(", "));
}

const created = await api("/api/keys", { method: "POST", token, body: { label: "e2e-test" } });
const rawKey = created.json?.rawKey;
log("issue api key", created.status === 201 && rawKey?.startsWith("urmiai_"), `prefix ${created.json?.keyPrefix}`);

const client = new Client({ name: "e2e", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
});
await client.connect(transport);
const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name);
log(
  "gateway tools/list",
  names.includes("woocommerce__list_products") && names.includes("notes__add_note"),
  names.join(", "),
);

const productName = `E2E Mug ${Date.now()}`;
const createdProduct = await client.callTool({
  name: "woocommerce__create_product",
  arguments: { name: productName, regularPrice: "19.99" },
});
const productText = JSON.stringify(createdProduct);
log("create product via gateway", productText.includes(productName) && !createdProduct.isError, productText.slice(0, 240));

const products = await client.callTool({ name: "woocommerce__list_products", arguments: { search: productName } });
log("list products via gateway", JSON.stringify(products).includes(productName), JSON.stringify(products).slice(0, 180));

let orderId = 0;
try {
  const createdOrder = JSON.parse(
    await kubectlPhp(`<?php
require "/var/www/html/wp-load.php";
$found = wc_get_products(["status" => "publish", "limit" => 1, "orderby" => "date", "order" => "DESC"]);
if (empty($found)) { fwrite(STDERR, "no product\\n"); exit(1); }
$order = wc_create_order();
$order->add_product($found[0], 1);
$order->set_payment_method("cod");
$order->set_payment_method_title("Cash on delivery");
$order->set_address([
  "first_name" => "E2E",
  "last_name" => "Buyer",
  "address_1" => "1 Test Street",
  "city" => "Pune",
  "postcode" => "411001",
  "country" => "IN",
  "email" => "buyer@example.com",
], "billing");
$order->calculate_totals();
$order->update_status("processing", "e2e checkout");
echo json_encode(["id" => $order->get_id(), "status" => $order->get_status(), "total" => $order->get_total()]);
`),
  );
  orderId = createdOrder.id;
  log("cash on delivery order created", createdOrder.status === "processing" && orderId > 0, `order ${orderId} total ${createdOrder.total}`);
} catch (err) {
  log("cash on delivery order created", false, err instanceof Error ? err.message : String(err));
}

if (orderId) {
  try {
    const listedOrders = await client.callTool({ name: "woocommerce__list_orders", arguments: { status: "processing", perPage: 20 } });
    const got = await client.callTool({ name: "woocommerce__get_order", arguments: { orderId } });
    const updated = await client.callTool({
      name: "woocommerce__update_order_status",
      arguments: { orderId, status: "completed" },
    });
    const listedText = JSON.stringify(listedOrders);
    const gotOrder = unwrapTool(got);
    const updatedOrder = unwrapTool(updated);
    log("list orders via gateway", listedText.includes(String(orderId)) && !listedOrders.isError, listedText.slice(0, 160));
    log("get order via gateway", gotOrder.id === orderId && gotOrder.billing?.email === "buyer@example.com", `id ${gotOrder.id} status ${gotOrder.status}`);
    log("complete order via gateway", updatedOrder.status === "completed" && !updated.isError, `status ${updatedOrder.status}`);
  } catch (err) {
    log("order tools via gateway", false, err instanceof Error ? err.message : String(err));
  }
}

const note = await client.callTool({ name: "notes__add_note", arguments: { text: "e2e note from gateway" } });
log("notes tool via gateway", JSON.stringify(note).includes("e2e note from gateway") && !note.isError, JSON.stringify(note).slice(0, 180));

await api(`/api/servers/${bySlug.notes.id}/disable`, { method: "POST", token });
const afterDisable = await client.listTools();
const disabledNames = afterDisable.tools.map((tool) => tool.name);
log(
  "disable notes hides its tools",
  !disabledNames.some((name) => name.startsWith("notes__")) && disabledNames.some((name) => name.startsWith("woocommerce__")),
  disabledNames.join(", "),
);
await api(`/api/servers/${bySlug.notes.id}/enable`, { method: "POST", token });
const afterEnable = await client.listTools();
log("enable notes restores tools", afterEnable.tools.some((tool) => tool.name === "notes__list_notes"), "notes__list_notes present");

const audit = await api("/api/audit?limit=50", { token });
const rows = audit.json ?? [];
const sawProduct = rows.some((row) => row.tool_name === "woocommerce__create_product" && row.success && row.user_email === "admin@example.com");
const sawNote = rows.some((row) => row.tool_name === "notes__add_note" && row.success);
log("audit log attributes calls", audit.status === 200 && sawProduct && sawNote, `${rows.length} recent rows`);

const memberEmail = `member-${Date.now()}@example.com`;
const member = await api("/api/auth/register", { method: "POST", body: { email: memberEmail, password: "password123" } });
const memberToken = member.json?.token;
log("second user is a member", member.status === 201 && member.json?.user?.role === "member", `${memberEmail} role ${member.json?.user?.role}`);
const memberAudit = await api("/api/audit?limit=50", { token: memberToken });
const memberRows = Array.isArray(memberAudit.json) ? memberAudit.json : [];
const memberSeesAdmin = memberRows.some((row) => row.user_email === "admin@example.com");
log("member audit hides other users", memberAudit.status === 200 && !memberSeesAdmin, `${memberRows.length} rows visible`);
const memberDisable = await api(`/api/servers/${bySlug.notes.id}/disable`, { method: "POST", token: memberToken });
log("member cannot disable a server", memberDisable.status === 403, `status ${memberDisable.status}`);

await api(`/api/keys/${created.json.id}/revoke`, { method: "POST", token });
let revokedRejected = false;
try {
  const revoked = new Client({ name: "e2e-revoked", version: "0.1.0" });
  const revokedTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
  });
  await revoked.connect(revokedTransport);
  await revoked.listTools();
} catch (err) {
  revokedRejected = true;
  log("revoked key rejected", true, err instanceof Error ? err.message.slice(0, 180) : String(err));
}
if (!revokedRejected) log("revoked key rejected", false, "call still succeeded");

const chat = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ messages: [{ role: "user", content: "What orders came in today?" }] }),
});
const chatBody = await chat.text();
log("chat endpoint responds", chat.status === 200 && chatBody.includes("event:"), `status ${chat.status} ${chatBody.slice(0, 220).replaceAll("\n", " | ")}`);

let productSlug = productName.toLowerCase().replaceAll(" ", "-");
try {
  productSlug = unwrapTool(createdProduct).slug || productSlug;
} catch {
  // The shop check still has the product name if the slug could not be parsed.
}
const shop = await httpGet(80, "/shop/", { Host: "store.urmiai.local" });
const productPage = await httpGet(80, `/product/${productSlug}/`, { Host: "store.urmiai.local" });
log("storefront shows new product", shop.status === 200 && shop.body.includes(productName), `status ${shop.status} hasName ${shop.body.includes(productName)}`);
log("product page is public", productPage.status === 200 && productPage.body.includes(productName), `status ${productPage.status}`);

await client.close();
console.log("\n---SUMMARY---");
console.log(out.filter((line) => line.startsWith("FAIL")).length === 0 ? "ALL_PASS" : "HAS_FAILURES");
