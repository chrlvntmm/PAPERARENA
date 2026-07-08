import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CONFIG } from "../config.js";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacToken(value: string): string {
  return createHmac("sha256", CONFIG.AUTH.SESSION_SECRET).update(value).digest("hex");
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashRequestValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return sha256(value);
}
