import { useState } from "react";
import { getToken } from "../api";

interface ChatLine {
  kind: "user" | "assistant" | "tool";
  text: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function ChatPage() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);

    const nextHistory: ChatMessage[] = [...history, { role: "user", content: text }];
    setHistory(nextHistory);
    setLines((prev) => [...prev, { kind: "user", text }]);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ messages: nextHistory }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const event = eventLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (event === "tool_call") {
          setLines((prev) => [...prev, { kind: "tool", text: `calling ${data.name}(${JSON.stringify(data.arguments)})` }]);
        } else if (event === "tool_result") {
          setLines((prev) => [...prev, { kind: "tool", text: toolResultText(String(data.name), Boolean(data.ok), String(data.result ?? "")) }]);
        } else if (event === "message") {
          assistantText = data.content;
          setLines((prev) => [...prev, { kind: "assistant", text: data.content }]);
        } else if (event === "error") {
          setLines((prev) => [...prev, { kind: "tool", text: `error: ${data.message}` }]);
        }
      }
    }

    if (assistantText) setHistory((prev) => [...prev, { role: "assistant", content: assistantText }]);
    setBusy(false);
  }

  return (
    <section>
      <h2>Chat Agent</h2>
      <div className="chat-log">
        {lines.map((line, index) => (
          <div className={`bubble ${line.kind}`} key={index}>{line.text}</div>
        ))}
      </div>
      <form className="row" onSubmit={send}>
        <input style={{ flex: 1 }} placeholder="Ask about products or orders" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
        <button className="btn" type="submit" disabled={busy}>{busy ? "Thinking" : "Send"}</button>
      </form>
    </section>
  );
}

function toolResultText(name: string, ok: boolean, result: string): string {
  return `${ok ? "result" : "error"} from ${name}: ${summarizeToolPayload(result)}`;
}

// The model still receives the full tool body. The panel only needs enough
// to show which call happened; a WooCommerce order is tens of kilobytes.
function summarizeToolPayload(raw: string): string {
  const value = parseToolJson(raw);
  if (value === undefined) return "ok";
  return describe(value);
}

function parseToolJson(raw: string): unknown {
  let text = raw;
  for (let depth = 0; depth < 3; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const inner = mcpText(parsed);
    if (inner === undefined) return parsed;
    text = inner;
  }
  return undefined;
}

function mcpText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const part = content.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "text");
  const text = part && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : undefined;
  return text;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every(isOrder)) return value.slice(0, 5).map(orderLine).join("; ");
    if (value.every(isProduct)) return value.slice(0, 5).map(productLine).join("; ");
    const notes = value.map(noteLine).filter(Boolean);
    if (notes.length === value.length) return notes.slice(0, 5).join("; ");
    return `${value.length} items`;
  }
  if (isOrder(value)) return orderLine(value);
  if (isProduct(value)) return productLine(value);
  const note = noteLine(value);
  if (note) return note;
  return "ok";
}

function isOrder(value: unknown): value is { id: unknown; status: unknown; total?: unknown; billing?: { first_name?: unknown; last_name?: unknown }; line_items?: { name?: unknown; quantity?: unknown }[] } {
  return Boolean(value && typeof value === "object" && "id" in value && "status" in value && ("billing" in value || "line_items" in value || "total" in value));
}

function isProduct(value: unknown): value is { name: unknown; price?: unknown; regular_price?: unknown } {
  return Boolean(value && typeof value === "object" && "name" in value && ("price" in value || "regular_price" in value) && !("billing" in value));
}

function orderLine(order: { id: unknown; status: unknown; total?: unknown; billing?: { first_name?: unknown; last_name?: unknown }; line_items?: { name?: unknown; quantity?: unknown }[] }): string {
  const who = [order.billing?.first_name, order.billing?.last_name].filter((part) => typeof part === "string" && part).join(" ");
  const items = (order.line_items ?? [])
    .map((item) => (typeof item.name === "string" ? `${item.quantity ?? 1}× ${item.name}` : ""))
    .filter(Boolean)
    .join(", ");
  const total = order.total !== undefined && order.total !== "" ? `, $${order.total}` : "";
  return `#${String(order.id)} ${who} — ${String(order.status)}${total}${items ? ` (${items})` : ""}`.replace(/\s+/g, " ").trim();
}

function productLine(product: { name: unknown; price?: unknown; regular_price?: unknown }): string {
  const price = product.price || product.regular_price;
  return price ? `${String(product.name)} $${price}` : String(product.name);
}

function noteLine(value: unknown): string {
  if (!value || typeof value !== "object" || !("text" in value)) return "";
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}
