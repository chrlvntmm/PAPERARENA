import type { IncomingMessage, ServerResponse } from "node:http";
import { CONFIG } from "../config.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function enforceRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  max: number,
): boolean {
  const result = checkRateLimit(req, scope, max);
  if (result.ok) return true;

  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": String(result.retryAfterSeconds),
  });
  res.end(JSON.stringify({ error: "RATE_LIMITED", message: "Too many requests." }));
  return false;
}

export function checkRateLimit(
  req: IncomingMessage,
  scope: string,
  max: number,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = `${scope}:${clientIp(req) ?? "unknown"}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + CONFIG.RATE_LIMIT.WINDOW_MS,
    });
    return { ok: true };
  }

  existing.count += 1;
  if (existing.count <= max) return { ok: true };

  return { ok: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
}

export function cleanupRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim();
  return req.socket.remoteAddress;
}
