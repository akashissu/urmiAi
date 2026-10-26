import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Deliberately trivial second upstream: an in-memory note store.
 * It exists so the "one prompt uses tools from two different upstreams"
 * demo does not depend on any third-party MCP server being reachable.
 * State is in-memory on purpose — losing it on restart is acceptable
 * because nothing here is the system of record.
 */
interface Note {
  id: string;
  text: string;
  createdAt: string;
}

// Demo fixtures, loaded when the process starts. The store is still
// in-memory; these three lines are what a restart should show on camera.
const notes: Note[] = [
  { id: "demo-1", text: "Restock stoneware mugs before Friday.", createdAt: "2026-10-26T09:00:00.000Z" },
  { id: "demo-2", text: "Luis Ortega asked for gift wrap on the kettle.", createdAt: "2026-10-26T11:30:00.000Z" },
  { id: "demo-3", text: "Northwind Cafe asked about a wholesale price for the mugs.", createdAt: "2026-10-26T14:00:00.000Z" },
];

function buildServer(): McpServer {
  const server = new McpServer({ name: "notes-mcp-server", version: "0.1.0" });

  server.registerTool(
    "add_note",
    { description: "Save a note.", inputSchema: { text: z.string().min(1) } },
    async ({ text }) => {
      const note: Note = { id: randomUUID(), text, createdAt: new Date().toISOString() };
      notes.push(note);
      return { content: [{ type: "text", text: JSON.stringify(note) }] };
    },
  );

  server.registerTool(
    "list_notes",
    { description: "List all saved notes, newest first.", inputSchema: {} },
    async () => {
      const ordered = [...notes].reverse();
      return { content: [{ type: "text", text: JSON.stringify(ordered) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const transport = transports.get(req.header("mcp-session-id") ?? "");
  if (!transport) return res.status(400).json({ error: "Unknown or missing mcp-session-id" });
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => console.log(`notes-mcp-server listening on :${PORT}`));
