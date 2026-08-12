import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "./config.js";

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireServiceToken(config: Config): RequestHandler {
  return (req, res, next) => {
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? req.header("x-api-key") ?? "";
    if (!constantTimeEqual(token, config.serviceToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function issueState(config: Config): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  const signature = createHmac("sha256", config.setupToken).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyState(config: Config, state: string): boolean {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", config.setupToken).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof value.exp === "number" && value.exp > Date.now();
  } catch { return false; }
}
