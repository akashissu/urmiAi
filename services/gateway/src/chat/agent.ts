import { config } from "../config.js";
import { listAggregatedTools, callAggregatedTool, writeAuditLog } from "../mcp/aggregator.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string; extraContent?: unknown }[];
}

export interface ChatEvent {
  type: "tool_call" | "tool_result" | "message" | "error";
  data: Record<string, unknown>;
}

const MAX_TOOL_ROUNDS = 5;

/**
 * Runs the tool loop as the logged-in user: every tools/call goes through
 * callAggregatedTool and is written to the audit log under userId, so a
 * chat-driven call is indistinguishable in the audit log from the same
 * user calling the tool through an external MCP client.
 *
 * The LLM is called through any OpenAI-compatible endpoint. The local
 * default is OpenAI. Gemini, Groq, or a local Ollama is the same request.
 */
export async function runChatTurn(
  userId: string,
  history: ChatMessage[],
  emit: (event: ChatEvent) => void,
): Promise<void> {
  if (!config.llm.apiKey) {
    emit({ type: "error", data: { message: "LLM_API_KEY is not configured" } });
    return;
  }

  const { tools } = await listAggregatedTools();
  const llmTools = tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant for a team that runs WooCommerce stores. Use the provided tools to answer questions about products and orders. Never invent data you did not get from a tool.",
    },
    ...history,
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callLlm(messages, llmTools);
    const choice = response.choices?.[0]?.message;
    if (!choice) {
      emit({ type: "error", data: { message: "LLM returned no choice" } });
      return;
    }

    if (!choice.tool_calls?.length) {
      emit({ type: "message", data: { content: choice.content ?? "" } });
      return;
    }

    messages.push({ role: "assistant", content: choice.content ?? "", toolCalls: choice.tool_calls.map(mapToolCall) });

    for (const toolCall of choice.tool_calls) {
      const args = safeParse(toolCall.function.arguments);
      emit({ type: "tool_call", data: { name: toolCall.function.name, arguments: args } });

      const startedAt = new Date();
      const { serverSlug, outcome } = await callAggregatedTool(toolCall.function.name, args);
      await writeAuditLog({
        userId,
        serverSlug,
        toolName: toolCall.function.name,
        startedAt,
        durationMs: outcome.durationMs,
        success: outcome.ok,
        errorMessage: outcome.ok ? null : outcome.message,
      });

      const resultText = outcome.ok ? JSON.stringify(outcome.result) : `Error (${outcome.reason}): ${outcome.message}`;
      emit({ type: "tool_result", data: { name: toolCall.function.name, ok: outcome.ok, result: resultText } });
      messages.push({ role: "tool", content: resultText, toolCallId: toolCall.id });
    }
  }

  emit({ type: "error", data: { message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds` } });
}

interface LlmToolCall {
  id: string;
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

function mapToolCall(toolCall: LlmToolCall): { id: string; name: string; arguments: string; extraContent?: unknown } {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    extraContent: toolCall.extra_content,
  };
}

async function callLlm(messages: ChatMessage[], tools: unknown[]): Promise<{ choices?: { message?: { content?: string; tool_calls?: LlmToolCall[] } }[] }> {
  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model: config.llm.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
          ...(call.extraContent === undefined ? {} : { extra_content: call.extraContent }),
        })),
      })),
      tools,
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<{ choices?: { message?: { content?: string; tool_calls?: LlmToolCall[] } }[] }>;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
