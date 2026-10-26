export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  auth_type: "none" | "header" | "bearer";
  auth_header_name: string | null;
  encrypted_credential: Buffer | null;
  credential_iv: Buffer | null;
  credential_auth_tag: Buffer | null;
  enabled: boolean;
  status: "connected" | "unreachable" | "unknown";
  last_checked_at: Date | null;
}

export interface AggregatedTool {
  /** "<slug>__<tool>" — what clients see and call. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverSlug: string;
  /** The tool's original name on the upstream server. */
  upstreamToolName: string;
}

export type CallFailureReason = "timeout" | "unreachable" | "upstream_error" | "not_found" | "disabled";

export interface CallSuccess {
  ok: true;
  result: unknown;
  durationMs: number;
}

export interface CallFailure {
  ok: false;
  reason: CallFailureReason;
  message: string;
  durationMs: number;
}

export type CallOutcome = CallSuccess | CallFailure;
