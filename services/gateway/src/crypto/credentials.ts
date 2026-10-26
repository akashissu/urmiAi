import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Upstream credentials must be reversible — the gateway has to send the
 * real value on every call — so this is authenticated encryption, not a
 * hash. The key lives only in a Kubernetes Secret, never in the database
 * and never in source. API keys are different: those are hashed with
 * argon2 because we only ever need to verify them, not recover them.
 */
export function encryptCredential(plaintext: string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, config.gatewayKek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptCredential(encrypted: EncryptedCredential): string {
  const decipher = createDecipheriv(ALGORITHM, config.gatewayKek, encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}
