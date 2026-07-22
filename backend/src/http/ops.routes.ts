import type { IncomingMessage, ServerResponse } from "node:http";
import { CONFIG } from "../config.js";
import {
  autoRefundExpiredDeposits,
  reconcileMatchLock,
  recoverStuckEscrowLocks,
  refundDepositIntent,
} from "../auth/escrow.service.js";
import { db } from "../db/postgres.js";

/**
 * Secret-gated ops endpoints for launch / recovery.
 * Header: x-ops-secret: <OPS_SECRET>
 */
export async function handleOpsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/ops/")) return false;

  if (!CONFIG.OPS_SECRET) {
    json(res, 503, { error: "OPS_DISABLED", message: "OPS_SECRET is not configured." });
    return true;
  }

  const provided = req.headers["x-ops-secret"];
  if (typeof provided !== "string" || provided !== CONFIG.OPS_SECRET) {
    json(res, 401, { error: "UNAUTHORIZED", message: "Invalid ops secret." });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/ops/health") {
    json(res, 200, {
      ok: true,
      env: CONFIG.NODE_ENV,
      cluster: CONFIG.RPC.SOLANA_CLUSTER,
      escrowBypass: CONFIG.ESCROW.BYPASS,
      programId: CONFIG.ESCROW.PROGRAM_ID ?? null,
      tokenMint: CONFIG.ESCROW.TOKEN_MINT ?? null,
      time: new Date().toISOString(),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/ops/escrow/recover") {
    const result = await recoverStuckEscrowLocks({ olderThanMs: 0 });
    json(res, 200, { ok: true, result });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/ops/escrow/reconcile-lock") {
    const matchId = url.searchParams.get("matchId");
    if (!matchId) {
      json(res, 400, { error: "BAD_REQUEST", message: "matchId query param required." });
      return true;
    }
    const result = await reconcileMatchLock(matchId);
    json(res, 200, { ok: true, result });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/ops/escrow/locks") {
    const status = url.searchParams.get("status") ?? "created";
    const olderThan = new Date(Date.now() - 1);
    const rows = await db.findStuckMatchFundLocks({
      statuses: status.split(",").map((s) => s.trim()).filter(Boolean),
      olderThan,
      limit: 50,
    });
    json(res, 200, { ok: true, locks: rows });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/ops/escrow/auto-refund-expired") {
    const result = await autoRefundExpiredDeposits({ limit: 30 });
    json(res, 200, { ok: true, result });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/ops/escrow/refund-deposit") {
    const depositIntentId = url.searchParams.get("depositIntentId");
    if (!depositIntentId) {
      json(res, 400, { error: "BAD_REQUEST", message: "depositIntentId query param required." });
      return true;
    }
    const intent = await db.findDepositIntentById(depositIntentId);
    if (!intent) {
      json(res, 404, { error: "NOT_FOUND", message: "Deposit intent not found." });
      return true;
    }
    try {
      const result = await refundDepositIntent({
        userId: intent.userId,
        wallet: {
          id: intent.walletId,
          userId: intent.userId,
          chainType: intent.chainType,
          chainId: intent.chainId,
          address: intent.walletAddress,
          addressNormalized: intent.walletAddress,
          firstVerifiedAt: intent.createdAt,
          lastVerifiedAt: intent.updatedAt,
          createdAt: intent.createdAt,
        },
        depositIntentId: intent.id,
      });
      json(res, 200, { ok: true, result });
    } catch (error) {
      json(res, 400, {
        error: "REFUND_FAILED",
        message: error instanceof Error ? error.message : "Refund failed.",
      });
    }
    return true;
  }

  json(res, 404, { error: "NOT_FOUND", message: "Unknown ops route." });
  return true;
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
