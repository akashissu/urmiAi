import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { WooCommerceClient } from "./woocommerceClient.js";

const PORT = Number(process.env.PORT ?? 8080);

const wc = new WooCommerceClient({
  baseUrl: required("WC_BASE_URL"),
  consumerKey: required("WC_CONSUMER_KEY"),
  consumerSecret: required("WC_CONSUMER_SECRET"),
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * This server speaks MCP over Streamable HTTP and is deployed as a
 * ClusterIP-only Service with no Ingress — by design, nothing outside the
 * cluster can reach it. Only the gateway (same cluster) talks to it.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce-mcp-server", version: "0.1.0" });

  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

  server.registerTool(
    "list_products",
    {
      description: "List products in the WooCommerce store, optionally filtered by search text.",
      inputSchema: {
        search: z.string().optional().describe("Free-text search on product name/SKU"),
        page: z.number().int().positive().optional(),
        perPage: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ search, page, perPage }) => text(await wc.listProducts({ search, page, perPage })),
  );

  server.registerTool(
    "create_product",
    {
      description: "Create a new simple product in the WooCommerce store.",
      inputSchema: {
        name: z.string().min(1),
        regularPrice: z.string().describe('Price as a string, e.g. "19.99"'),
        description: z.string().optional(),
        sku: z.string().optional(),
        stockQuantity: z.number().int().optional(),
      },
    },
    async (input) => text(await wc.createProduct(input)),
  );

  server.registerTool(
    "list_orders",
    {
      description: "List orders, optionally filtered by status or date.",
      inputSchema: {
        after: z.string().datetime().optional().describe("ISO8601 - only orders created after this"),
        status: z.string().optional().describe("e.g. pending, processing, completed, cancelled"),
        perPage: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ after, status, perPage }) => text(await wc.listOrders({ after, status, perPage })),
  );

  server.registerTool(
    "get_order",
    {
      description: "Get full details of a single order by id.",
      inputSchema: { orderId: z.number().int().positive() },
    },
    async ({ orderId }) => text(await wc.getOrder(orderId)),
  );

  server.registerTool(
    "update_order_status",
    {
      description: "Update the status of an order (e.g. mark as completed or cancelled).",
      inputSchema: {
        orderId: z.number().int().positive(),
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
      },
    },
    async ({ orderId, status }) => text(await wc.updateOrderStatus(orderId, status)),
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// Streamable HTTP transport, one per session (per MCP spec guidance),
// keyed by the mcp-session-id header the SDK manages for us.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    const server = buildServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "Unknown or missing mcp-session-id" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`woocommerce-mcp-server listening on :${PORT}`);
});
