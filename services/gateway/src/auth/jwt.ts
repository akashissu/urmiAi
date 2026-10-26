import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface SessionClaims {
  sub: string;
  email: string;
  role: "admin" | "member";
}

const TOKEN_TTL = "12h";

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    return jwt.verify(token, config.jwtSecret) as SessionClaims;
  } catch {
    return null;
  }
}
