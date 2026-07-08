import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { clearSessionCookie, getSessionTokenFromCookie, setSessionCookie } from "../auth/cookies.js";
import {
  authenticateSessionToken,
  createAuthChallenge,
  publicIdentity,
  revokeSession,
  verifyAuthChallenge,
  type RequestFingerprint,
} from "../auth/auth.service.js";
import { enforceRateLimit } from "./rate-limit.js";

const challengeSchema = z.object({
  chainType: z.enum(["solana", "evm"]),
  chainId: z.string().min(1),
  address: z.string().min(1),
});

const verifySchema = challengeSchema.extend({
  challengeId: z.string().uuid(),
  signature: z.string().min(1),
});

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return true;
  }

  const url = new URL(req.url ?? "/", CONFIG.AUTH.EXPECTED_URI);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    text(res, 200, "ok");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/challenge") {
    if (!enforceRateLimit(req, res, "auth:challenge", CONFIG.RATE_LIMIT.AUTH_CHALLENGE_MAX)) {
      return true;
    }
    await routeJson(req, res, async (body) => {
      const input = challengeSchema.parse(body);
      return createAuthChallenge({ ...input, fingerprint: fingerprint(req) });
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/verify") {
    if (!enforceRateLimit(req, res, "auth:verify", CONFIG.RATE_LIMIT.AUTH_VERIFY_MAX)) {
      return true;
    }
    await routeJson(req, res, async (body) => {
      const input = verifySchema.parse(body);
      const verified = await verifyAuthChallenge({ ...input, fingerprint: fingerprint(req) });
      setSessionCookie(res, verified.rawSessionToken);
      return {
        user: verified.user,
        wallets: verified.wallets,
      };
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }
    json(res, 200, publicIdentity(identity));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    await revokeSession(getSessionTokenFromCookie(req));
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && CONFIG.AUTH.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

async function routeJson(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: unknown) => Promise<unknown>,
) {
  try {
    const body = await readJson(req);
    const payload = await handler(body);
    json(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    json(res, 400, { error: "BAD_REQUEST", message });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fingerprint(req: IncomingMessage): RequestFingerprint {
  return {
    ip: clientIp(req),
    userAgent: req.headers["user-agent"],
  };
}

function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim();
  return req.socket.remoteAddress;
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}
