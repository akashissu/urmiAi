import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { pool } from "../db/pool.js";

const PREFIX_LENGTH = 8;

export interface ApiKeyRecord {
  id: string;
  userId: string;
  label: string;
  keyPrefix: string;
  isPrimary: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Generates a key, stores only its argon2id hash plus a short prefix
 * (so the UI can show "key starting with abcd1234" without us keeping
 * the raw value), and returns the raw key exactly once to the caller.
 */
export async function issueApiKey(
  userId: string,
  label: string,
  isPrimary = false,
): Promise<{ record: ApiKeyRecord; rawKey: string }> {
  const rawKey = `urmiai_${randomBytes(24).toString("base64url")}`;
  const keyHash = await argon2.hash(rawKey);
  const keyPrefix = rawKey.slice(0, PREFIX_LENGTH);

  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, label, is_primary)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, label, key_prefix, is_primary, revoked_at, last_used_at, created_at`,
    [userId, keyHash, keyPrefix, label, isPrimary],
  );
  return { record: mapRow(rows[0]), rawKey };
}

/**
 * The prefix narrows the candidate rows to a handful before we pay for
 * argon2 verification, instead of scanning every key in the table.
 */
export async function verifyApiKey(rawKey: string): Promise<{ userId: string; keyId: string } | null> {
  const keyPrefix = rawKey.slice(0, PREFIX_LENGTH);
  const { rows } = await pool.query(
    `SELECT id, user_id, key_hash FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [keyPrefix],
  );
  for (const row of rows) {
    if (await argon2.verify(row.key_hash, rawKey)) {
      await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
      return { userId: row.user_id, keyId: row.id };
    }
  }
  return null;
}

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, user_id, label, key_prefix, is_primary, revoked_at, last_used_at, created_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapRow);
}

export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId],
  );
  return (rowCount ?? 0) > 0;
}

function mapRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    label: row.label as string,
    keyPrefix: row.key_prefix as string,
    isPrimary: row.is_primary as boolean,
    revokedAt: (row.revoked_at as Date) ?? null,
    lastUsedAt: (row.last_used_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}
