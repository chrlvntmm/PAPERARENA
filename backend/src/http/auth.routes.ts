import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { clearSessionCookie, getSessionTokenFromCookie, setSessionCookie } from "../auth/cookies.js";
import {
  authenticateSessionToken,
  createAuthChallenge,
  publicIdentity,
  revokeSession,
  updateUserDisplayName,
  verifyAuthChallenge,
  type RequestFingerprint,
} from "../auth/auth.service.js";
import { enforceRateLimit } from "./rate-limit.js";
import { getWalletBalance } from "../wallet/balance.service.js";
import {
  confirmDeposit,
  createDepositIntent,
  getDepositIntentStatus,
} from "../auth/escrow.service.js";

const challengeSchema = z.object({
  chainType: z.enum(["solana", "evm"]),
  chainId: z.string().min(1),
  address: z.string().min(1),
});

const verifySchema = challengeSchema.extend({
  challengeId: z.string().uuid(),
  signature: z.string().min(1),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(3).max(16).regex(/^[A-Za-z0-9_]+$/),
});

const depositIntentSchema = z.object({
  arena: z.enum(["standard", "mega"]),
  wager: z.number().positive(),
  walletId: z.string().uuid().optional(),
});

const depositConfirmSchema = z.object({
  depositIntentId: z.string().uuid(),
  txSignature: z.string().min(1),
  walletId: z.string().uuid().optional(),
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

  if (req.method === "PATCH" && url.pathname === "/auth/profile") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }

    await routeJson(req, res, async (body) => {
      const input = profileSchema.parse(body);
      const user = await updateUserDisplayName(identity, input.displayName);
      return { user };
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/wallet/balance") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }

    const walletId = url.searchParams.get("walletId");
    const wallet = walletId
      ? identity.wallets.find((candidate) => candidate.id === walletId)
      : identity.wallets.find((candidate) => candidate.chainType === "solana") ?? identity.wallets[0];

    if (!wallet) {
      json(res, 404, { error: "WALLET_NOT_FOUND", message: "No verified wallet found for this session." });
      return true;
    }

    try {
      json(res, 200, await getWalletBalance(wallet));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh wallet balance.";
      json(res, 502, { error: "BALANCE_UNAVAILABLE", message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/wallet/escrow-info") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }
    json(res, 200, {
      cluster: CONFIG.RPC.SOLANA_CLUSTER,
      programId: CONFIG.ESCROW.PROGRAM_ID ?? null,
      tokenMint: CONFIG.ESCROW.TOKEN_MINT ?? null,
      tokenSymbol: CONFIG.ESCROW.TOKEN_SYMBOL,
      tokenDecimals: CONFIG.ESCROW.TOKEN_DECIMALS,
      bypass: CONFIG.ESCROW.BYPASS,
      model: "pay_per_match",
      note:
        "Wagers pull from your wallet wager-token balance into match escrow. Wins settle back to your wallet automatically.",
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/wallet/deposit-intent") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }

    await routeJson(req, res, async (body) => {
      const input = depositIntentSchema.parse(body);
      const wallet = input.walletId
        ? identity.wallets.find((candidate) => candidate.id === input.walletId)
        : identity.wallets.find((candidate) => candidate.chainType === "solana") ??
          identity.wallets[0];
      if (!wallet) {
        throw new Error("No verified wallet found for this session.");
      }
      return createDepositIntent({
        userId: identity.user.id,
        wallet,
        arena: input.arena,
        wager: input.wager,
      });
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/wallet/deposit-status") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }

    const depositIntentId = url.searchParams.get("depositIntentId");
    if (!depositIntentId) {
      json(res, 400, { error: "BAD_REQUEST", message: "depositIntentId is required." });
      return true;
    }

    const solanaWallet = identity.wallets.find((wallet) => wallet.chainType === "solana");
    const walletId =
      url.searchParams.get("walletId") ?? solanaWallet?.id ?? identity.wallets[0]?.id;
    const wallet = identity.wallets.find((candidate) => candidate.id === walletId);
    if (!walletId || !wallet) {
      json(res, 404, { error: "WALLET_NOT_FOUND", message: "No verified wallet found for this session." });
      return true;
    }

    const status = await getDepositIntentStatus({
      userId: identity.user.id,
      walletId,
      depositIntentId,
      walletAddress: wallet.address,
    });
    if (!status) {
      json(res, 404, { error: "DEPOSIT_INTENT_NOT_FOUND", message: "Deposit intent not found." });
      return true;
    }
    json(res, 200, status);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/wallet/deposit-confirm") {
    const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
    if (!identity) {
      json(res, 401, { error: "UNAUTHENTICATED", message: "No active session." });
      return true;
    }

    await routeJson(req, res, async (body) => {
      const input = depositConfirmSchema.parse(body);
      const wallet = input.walletId
        ? identity.wallets.find((candidate) => candidate.id === input.walletId)
        : identity.wallets.find((candidate) => candidate.chainType === "solana") ??
          identity.wallets[0];
      if (!wallet) {
        throw new Error("No verified wallet found for this session.");
      }
      return confirmDeposit({
        userId: identity.user.id,
        wallet,
        depositIntentId: input.depositIntentId,
        txSignature: input.txSignature,
      });
    });
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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
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
