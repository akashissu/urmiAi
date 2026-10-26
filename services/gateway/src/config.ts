/**
 * Read once at startup. Anything security-sensitive has no default —
 * a missing value crashes the process instead of silently running
 * with a guess (see skills/urmiai-conventions).
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  /** 32-byte key, base64-encoded, for AES-256-GCM. */
  gatewayKek: Buffer.from(required("GATEWAY_KEK"), "base64"),
  jwtSecret: required("JWT_SECRET"),
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4.1-mini",
  },
  /**
   * Local dev needs this because our own upstreams use cluster-internal
   * DNS names, which the SSRF guard would otherwise reject. Never set
   * in production values. See docs/INTERVIEW_PREP.md.
   */
  allowInternalUpstreams: process.env.ALLOW_INTERNAL_UPSTREAMS === "true",
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15_000),
  healthCheckIntervalMs: Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 15_000),
};

if (config.gatewayKek.length !== 32) {
  throw new Error("GATEWAY_KEK must decode to exactly 32 bytes");
}
