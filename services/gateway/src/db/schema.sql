-- Gateway's own state. Nothing here ever stores the upstream data itself
-- (orders, products) — only who/what/when for routing and auditing.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every user gets one "primary" key automatically (used by the chat agent,
-- so its calls are attributable to the logged-in user). Users can also
-- mint extra keys for external MCP clients (Cursor, Claude Code, Inspector).
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,              -- argon2id hash, never the raw key
  key_prefix    TEXT NOT NULL,              -- first 8 chars of raw key, for UI display/lookup hint
  label         TEXT NOT NULL DEFAULT 'default',
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 TEXT UNIQUE NOT NULL,      -- used as the tool-name prefix: "<slug>__<tool>"
  name                 TEXT NOT NULL,
  base_url             TEXT NOT NULL,
  auth_type            TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'header', 'bearer')),
  auth_header_name     TEXT,                       -- only used when auth_type = 'header'
  encrypted_credential BYTEA,                      -- AES-256-GCM ciphertext, NULL if auth_type = 'none'
  credential_iv        BYTEA,
  credential_auth_tag  BYTEA,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  status               TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('connected', 'unreachable', 'unknown')),
  last_checked_at      TIMESTAMPTZ,
  owner_store_id       UUID,                       -- set for bonus: multi-store provisioning
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  server_slug   TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  duration_ms   INTEGER NOT NULL,
  success       BOOLEAN NOT NULL,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_slug, created_at DESC);
