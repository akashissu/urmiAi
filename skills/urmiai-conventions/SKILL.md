---
name: urmiai-conventions
description: Conventions for building the UrmiAi MCP Gateway assessment — naming, error handling, secrets, and how to keep the design docs in sync with the code. Use whenever writing or modifying code in services/ or helm/.
---

# UrmiAi Conventions

## Naming
- MCP tool names exposed by an upstream server: `snake_case` (e.g. `list_orders`).
- Gateway-aggregated tool names: `<server_slug>__<tool_name>`, slug is `[a-z0-9-]+`, chosen at server registration time and unique.
- Kubernetes resource names: `<component>` (e.g. `gateway`, `woocommerce-mcp`, `wordpress`, `mariadb`). Namespace per concern: `platform` for gateway/dashboard/postgres, `store-<slug>` for each store.
- Database tables/columns: `snake_case`. TypeScript: `camelCase` for functions/vars, `PascalCase` for types/classes.

## Error handling
- Upstream failures are data, not exceptions, once inside the aggregator. Convert timeouts/connection errors into a structured result `{ ok: false, reason: "timeout" | "unreachable" | "upstream_error", message }` before they leave the per-upstream call.
- Distinguish "this specific upstream failed" from "the gateway itself failed" in every error returned to a client — the demo explicitly tests that one dead upstream doesn't break the others, and the dashboard must show *why*.

## Secrets & config
- Read config once at startup via a `required(name)` helper that throws if missing. No fallback defaults for anything security-sensitive.
- Never log request headers (they carry API keys) or decrypted credentials.

## Docs stay in sync
- New exported function → add a row to `docs/CODEBASE_MAP.md`.
- New architectural decision → add a Q&A block to `docs/INTERVIEW_PREP.md`.
- Both happen in the same change as the code, not as a later cleanup pass.

## MCP specifics
- Use `@modelcontextprotocol/sdk` for both server and client sides; don't hand-roll the JSON-RPC framing.
- Streamable HTTP transport only (not the legacy SSE-only transport) — it's what the assignment specifies.
- Always set an explicit timeout (`AbortController`) on any call to an upstream. No unbounded waits.

## Testing each piece
- Verify behavior with a real call (curl, MCP Inspector, or the dashboard) before calling a task done — don't rely on "it compiles" or unit tests alone for the definition-of-done flows.
