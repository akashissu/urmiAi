import type { Request, Response, NextFunction } from "express";
import { verifySession, type SessionClaims } from "./jwt.js";
import { verifyApiKey } from "./apiKeys.js";

export interface AuthedRequest extends Request {
  user?: SessionClaims;
  apiKeyUserId?: string;
}

export function requireUser(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const claims = token ? verifySession(token) : null;
  if (!claims) {
    res.status(401).json({ error: "Missing or invalid session token" });
    return;
  }
  req.user = claims;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}

/** Used by the MCP endpoint, where callers authenticate with an API key rather than a dashboard JWT. */
export async function requireApiKey(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization") ?? "";
  const rawKey = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!rawKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }
  const result = await verifyApiKey(rawKey);
  if (!result) {
    res.status(401).json({ error: "Invalid or revoked API key" });
    return;
  }
  req.apiKeyUserId = result.userId;
  next();
}
