import { createHash, randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CONFIG, type ArenaType, type WagerAmount } from "../config.js";
import { db, type DepositIntentDocument, type WalletDocument } from "../db/postgres.js";
import {
  DEPOSIT_STATUS,
  fetchDepositEscrow,
  fetchMatchEscrow,
  fetchSettlementRecordExists,
  forfeitMatchOnChain,
  getEscrowProgram,
  intentIdToHex,
  isEscrowProgramConfigured,
  lockMatchOnChain,
  probeMatchEscrow,
  probeSettlementRecordExists,
  publicDepositBuildParams,
  randomIntentId,
  randomMatchId,
  settleMatchOnChain,
  wagerAmountBaseUnits,
} from "../escrow/program.js";

export type DepositStatus =
  | "created"
  | "awaiting_payment"
  | "submitted"
  | "verified"
  | "expired"
  | "consumed"
  | "failed"
  | "refunded"
  | "forfeited";

export interface PublicDepositIntent {
  id: string;
  arena: ArenaType;
  wagerUsd: string;
  status: DepositStatus;
  contractStatus: "not_configured" | "configured";
  tokenSymbol?: string;
  tokenMint?: string;
  amountBaseUnits?: string;
  onChainIntentId?: string;
  txSignature?: string;
  verificationError?: string;
  expiresAt: string;
  verifiedAt?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
  build?: ReturnType<typeof publicDepositBuildParams>;
}

export function isEscrowConfigured(): boolean {
  return isEscrowProgramConfigured() || CONFIG.ESCROW.BYPASS;
}

export async function createDepositIntent(args: {
  userId: string;
  wallet: WalletDocument;
  arena: ArenaType;
  wager: WagerAmount;
}): Promise<PublicDepositIntent> {
  assertSupportedWager(args.wager);

  if (args.wallet.chainType !== "solana") {
    throw new Error("Paid matches require a verified Solana wallet.");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONFIG.AUTH.DEPOSIT_INTENT_TTL_SECONDS * 1000);
  const contractConfigured = isEscrowProgramConfigured();

  const existing = await db.findLatestDepositIntent({
    userId: args.userId,
    walletId: args.wallet.id,
    arena: args.arena,
    wagerUsd: wagerToUsd(args.wager),
  });

  if (
    existing &&
    existing.expiresAt > now &&
    !["consumed", "refunded", "forfeited", "failed"].includes(existing.status)
  ) {
    // Re-check chain for awaiting/submitted intents so UI can refresh cleanly.
    if (
      contractConfigured &&
      (existing.status === "awaiting_payment" || existing.status === "submitted")
    ) {
      const refreshed = await verifyDepositOnChain({
        intent: existing,
        wallet: args.wallet,
        txSignature: existing.txSignature,
      });
      if (refreshed) return publicDepositIntent(refreshed, args.wallet.address);
    }
    return publicDepositIntent(existing, args.wallet.address);
  }

  const onChainIntentId = intentIdToHex(randomIntentId());
  const amountBaseUnits = contractConfigured
    ? wagerAmountBaseUnits(Number(args.wager), CONFIG.ESCROW.TOKEN_DECIMALS).toString()
    : undefined;

  const intent: DepositIntentDocument = {
    id: randomUUID(),
    userId: args.userId,
    walletId: args.wallet.id,
    walletAddress: args.wallet.address,
    chainType: args.wallet.chainType,
    chainId: args.wallet.chainId,
    arena: args.arena,
    wagerUsd: wagerToUsd(args.wager),
    tokenSymbol: contractConfigured ? CONFIG.ESCROW.TOKEN_SYMBOL : undefined,
    tokenMint: contractConfigured ? CONFIG.ESCROW.TOKEN_MINT : undefined,
    amountBaseUnits,
    status: contractConfigured || CONFIG.ESCROW.BYPASS ? "awaiting_payment" : "created",
    contractStatus: contractConfigured ? "configured" : "not_configured",
    verificationError: contractConfigured
      ? undefined
      : CONFIG.ESCROW.BYPASS
        ? undefined
        : "Solana escrow contract is not configured yet.",
    // Store 32-byte on-chain intent id (hex) in the unique idempotency key column.
    idempotencyKey: onChainIntentId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  // Local demo path: mark verified without requiring an on-chain deposit.
  if (CONFIG.ESCROW.BYPASS) {
    intent.status = "verified";
    intent.verifiedAt = now;
    intent.txSignature = "dev-bypass";
    intent.contractStatus = contractConfigured ? "configured" : "not_configured";
    intent.tokenSymbol = CONFIG.ESCROW.TOKEN_SYMBOL;
    intent.tokenMint = contractConfigured ? CONFIG.ESCROW.TOKEN_MINT : intent.tokenMint;
    intent.amountBaseUnits = wagerAmountBaseUnits(
      Number(args.wager),
      CONFIG.ESCROW.TOKEN_DECIMALS,
    ).toString();
    intent.verificationError = undefined;
  }

  await db.insertDepositIntent(intent);
  return publicDepositIntent(intent, args.wallet.address);
}

export async function getDepositIntentStatus(args: {
  userId: string;
  walletId: string;
  depositIntentId: string;
  walletAddress?: string;
}): Promise<PublicDepositIntent | null> {
  const intent = await db.findDepositIntentById(args.depositIntentId);
  if (!intent || intent.userId !== args.userId || intent.walletId !== args.walletId) {
    return null;
  }

  if (
    isEscrowProgramConfigured() &&
    (intent.status === "awaiting_payment" || intent.status === "submitted")
  ) {
    const refreshed = await verifyDepositOnChain({
      intent,
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
      txSignature: intent.txSignature,
    });
    if (refreshed) return publicDepositIntent(refreshed, args.walletAddress ?? intent.walletAddress);
  }

  return publicDepositIntent(intent, args.walletAddress ?? intent.walletAddress);
}

export async function confirmDeposit(args: {
  userId: string;
  wallet: WalletDocument;
  depositIntentId: string;
  txSignature: string;
}): Promise<PublicDepositIntent> {
  const intent = await db.findDepositIntentById(args.depositIntentId);
  if (!intent || intent.userId !== args.userId || intent.walletId !== args.wallet.id) {
    throw new Error("Deposit intent not found.");
  }
  if (intent.chainType !== "solana") {
    throw new Error("Paid matches require a Solana deposit.");
  }

  if (CONFIG.ESCROW.BYPASS) {
    const now = new Date();
    await db.updateDepositIntent({
      id: intent.id,
      status: "verified",
      txSignature: args.txSignature || "dev-bypass",
      verifiedAt: now,
      verificationError: null,
      updatedAt: now,
    });
    const updated = await db.findDepositIntentById(intent.id);
    return publicDepositIntent(updated!, args.wallet.address);
  }

  if (!isEscrowProgramConfigured()) {
    throw new Error("Solana escrow contract is not configured yet.");
  }

  const submittedAt = new Date();
  await db.updateDepositIntent({
    id: intent.id,
    status: "submitted",
    txSignature: args.txSignature,
    updatedAt: submittedAt,
  });

  const refreshed = await verifyDepositOnChain({
    intent: { ...intent, txSignature: args.txSignature, status: "submitted" },
    wallet: args.wallet,
    txSignature: args.txSignature,
  });
  if (!refreshed || refreshed.status !== "verified") {
    throw new Error(refreshed?.verificationError ?? "Deposit could not be verified on-chain.");
  }
  return publicDepositIntent(refreshed, args.wallet.address);
}

/** Confirm a verified, unused deposit before queue entry. Does not consume. */
export async function verifyEscrowBuyIn(
  publicKey: string,
  wagerUsd: number,
  _matchId: string,
  options: {
    userId?: string;
    walletId?: string;
    arena?: ArenaType;
    depositIntentId?: string;
  } = {},
): Promise<{ ok: boolean; txSignature?: string; reason?: string; onChainIntentId?: string }> {
  if (CONFIG.ESCROW.BYPASS) {
    return { ok: true, txSignature: "dev-bypass", onChainIntentId: "dev-bypass" };
  }

  if (!options.userId || !options.walletId) {
    return { ok: false, reason: "Session is missing wallet identity. Sign out and sign in again." };
  }
  if (!options.arena) {
    return { ok: false, reason: "Arena selection is required." };
  }
  if (!options.depositIntentId) {
    return {
      ok: false,
      reason:
        "Deposit verification is required before joining. Complete the on-chain deposit first (or enable ESCROW_BYPASS for local demos).",
    };
  }

  const intent = await db.findDepositIntentById(options.depositIntentId);
  if (!intent || intent.userId !== options.userId || intent.walletId !== options.walletId) {
    return { ok: false, reason: "Deposit intent not found." };
  }
  if (intent.arena !== options.arena || intent.wagerUsd !== wagerToUsd(wagerUsd)) {
    return { ok: false, reason: "Deposit does not match arena/wager selection." };
  }
  if (intent.walletAddress !== publicKey) {
    return { ok: false, reason: "Deposit wallet does not match session wallet." };
  }
  if (intent.consumedAt || intent.status === "consumed") {
    return { ok: false, reason: "Deposit has already been used." };
  }
  if (intent.expiresAt <= new Date()) {
    return { ok: false, reason: "Deposit intent expired." };
  }

  if (intent.status !== "verified") {
    // Last-chance on-chain recheck
    if (isEscrowProgramConfigured()) {
      const refreshed = await verifyDepositOnChain({
        intent,
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
        txSignature: intent.txSignature,
      });
      if (!refreshed || refreshed.status !== "verified") {
        return { ok: false, reason: refreshed?.verificationError ?? "Deposit is not verified." };
      }
    } else {
      return { ok: false, reason: "Deposit is not verified." };
    }
  }

  // Re-read chain to ensure still Funded (not consumed elsewhere)
  if (isEscrowProgramConfigured()) {
    const onChain = await fetchDepositEscrow(intent.idempotencyKey);
    if (!onChain || onChain.escrow.status !== DEPOSIT_STATUS.Funded) {
      return { ok: false, reason: "On-chain deposit is not funded or already used." };
    }
  }

  return {
    ok: true,
    txSignature: intent.txSignature,
    onChainIntentId: intent.idempotencyKey,
  };
}

export async function lockMatchFunds(args: {
  matchId: string;
  arena: ArenaType;
  wager: WagerAmount;
  players: Array<{
    walletAddress: string;
    walletId?: string;
    depositIntentId?: string;
  }>;
}): Promise<{
  ok: boolean;
  /** Chain/RPC state unknown — deposits stay reserved; do not treat as hard failure. */
  pending?: boolean;
  onChainMatchIdHex?: string;
  txSignature?: string;
  reason?: string;
}> {
  if (CONFIG.ESCROW.BYPASS) {
    return {
      ok: true,
      txSignature: "dev-bypass",
      onChainMatchIdHex: createHash("sha256").update(args.matchId).digest("hex"),
    };
  }

  if (!isEscrowProgramConfigured()) {
    return { ok: false, reason: "Escrow program is not configured." };
  }

  const existing = await db.findMatchFundLockByMatchId(args.matchId);
  if (existing?.status === "locked" || existing?.status === "settled" || existing?.status === "forfeited") {
    return {
      ok: true,
      txSignature: existing.lockTxSignature,
      onChainMatchIdHex: existing.onChainMatchIdHex,
    };
  }

  const intents: DepositIntentDocument[] = [];
  for (const player of args.players) {
    if (!player.depositIntentId) {
      return { ok: false, reason: "Every player needs a verified deposit to lock the match." };
    }
    const intent = await db.findDepositIntentById(player.depositIntentId);
    if (!intent || intent.status !== "verified" || intent.consumedAt) {
      return { ok: false, reason: `Deposit not ready for wallet ${player.walletAddress}.` };
    }
    if (intent.walletAddress !== player.walletAddress) {
      return { ok: false, reason: "Deposit wallet mismatch during lock." };
    }
    intents.push(intent);
  }

  const now = new Date();
  const onChainMatchId = randomMatchId();
  const onChainMatchIdHex = intentIdToHex(onChainMatchId);
  const lockId = existing?.id ?? randomUUID();
  const totalBaseUnits = (
    wagerAmountBaseUnits(Number(args.wager), CONFIG.ESCROW.TOKEN_DECIMALS) * BigInt(intents.length)
  ).toString();

  // 1) Persist lock row in "created" (locking) before chain call.
  await db.insertMatchFundLock({
    id: lockId,
    matchId: args.matchId,
    arena: args.arena,
    wagerUsd: wagerToUsd(args.wager),
    tokenSymbol: CONFIG.ESCROW.TOKEN_SYMBOL,
    tokenMint: CONFIG.ESCROW.TOKEN_MINT,
    totalBaseUnits,
    status: "created",
    onChainMatchIdHex,
    createdAt: now,
    updatedAt: now,
  });

  for (const intent of intents) {
    await db.insertMatchFundLockPlayer({
      id: randomUUID(),
      matchFundLockId: lockId,
      walletId: intent.walletId,
      walletAddress: intent.walletAddress,
      depositIntentId: intent.id,
      amountBaseUnits: intent.amountBaseUnits,
      createdAt: now,
    });
  }

  // 2) Atomically consume deposits in DB before chain. Abort if any fail.
  const consume = await db.consumeVerifiedDepositIntentsAtomic({
    ids: intents.map((i) => i.id),
    arena: args.arena,
    wagerUsd: wagerToUsd(args.wager),
    consumedAt: now,
  });
  if (!consume.ok) {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "failed",
      updatedAt: new Date(),
    });
    console.error("[escrow] lock aborted: deposit consume failed", {
      matchId: args.matchId,
      intentIds: intents.map((i) => i.id),
    });
    return { ok: false, reason: "Could not reserve deposits for match lock." };
  }

  // 3) Chain lock — store submitted sig ASAP; on error reconcile chain before releasing DB.
  try {
    const txSignature = await lockMatchOnChain({
      matchId: onChainMatchId,
      depositIntentHexes: intents.map((intent) => intent.idempotencyKey),
      onSubmitted: async (sig) => {
        await db.updateMatchFundLockStatus({
          matchId: args.matchId,
          status: "created",
          lockTxSignature: sig,
          updatedAt: new Date(),
        });
      },
    });

    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "locked",
      lockTxSignature: txSignature,
      updatedAt: new Date(),
    });

    console.info("[escrow] match locked", {
      matchId: args.matchId,
      onChainMatchIdHex,
      txSignature,
      players: intents.map((i) => i.walletAddress),
    });

    return { ok: true, txSignature, onChainMatchIdHex };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to lock match funds on-chain.";

    // 4) Reconcile chain carefully:
    // - exists → locked (success)
    // - absent (proven) → release deposits + failed
    // - unknown (RPC/read error) → keep pending, NEVER release deposits
    const probe = await probeMatchEscrow(onChainMatchIdHex);
    if (probe.kind === "exists") {
      await db.updateMatchFundLockStatus({
        matchId: args.matchId,
        status: "locked",
        updatedAt: new Date(),
      });
      console.warn("[escrow] lock confirm failed but on-chain match exists — marking locked", {
        matchId: args.matchId,
        onChainMatchIdHex,
        chainStatus: probe.escrow.status,
        reason: message,
      });
      return { ok: true, onChainMatchIdHex, reason: message };
    }

    if (probe.kind === "unknown") {
      // Leave status=created, deposits consumed. Recovery will re-probe.
      console.error("[escrow] lock outcome UNKNOWN — holding deposits pending chain read", {
        matchId: args.matchId,
        onChainMatchIdHex,
        reason: message,
        probeError: probe.error,
      });
      return {
        ok: false,
        pending: true,
        onChainMatchIdHex,
        reason:
          "Match lock is pending confirmation. Funds remain reserved until the chain is readable.",
      };
    }

    // Proven absent — safe to release.
    for (const id of consume.consumed) {
      await db.releaseConsumedDepositIntent({ id, updatedAt: new Date() });
    }
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "failed",
      updatedAt: new Date(),
    });
    console.error("[escrow] lock chain failed; deposits released (no on-chain match)", {
      matchId: args.matchId,
      onChainMatchIdHex,
      reason: message,
    });
    return { ok: false, reason: message };
  }
}

/** Re-check a pending lock (status created) against chain. Used after pending or by recovery. */
export async function reconcileMatchLock(matchId: string): Promise<{
  ok: boolean;
  pending?: boolean;
  onChainMatchIdHex?: string;
  txSignature?: string;
  reason?: string;
}> {
  const lock = await db.findMatchFundLockByMatchId(matchId);
  if (!lock) {
    return { ok: false, reason: "Match fund lock not found." };
  }
  if (lock.status === "locked" || lock.status === "settled" || lock.status === "forfeited") {
    return {
      ok: true,
      onChainMatchIdHex: lock.onChainMatchIdHex,
      txSignature: lock.lockTxSignature,
    };
  }
  if (lock.status === "failed") {
    return { ok: false, reason: "Match fund lock previously failed." };
  }
  if (!lock.onChainMatchIdHex) {
    return { ok: false, pending: true, reason: "Lock has no on-chain match id yet." };
  }

  const probe = await probeMatchEscrow(lock.onChainMatchIdHex);
  if (probe.kind === "exists") {
    const status =
      probe.escrow.status === "settled"
        ? "settled"
        : probe.escrow.status === "forfeited"
          ? "forfeited"
          : "locked";
    await db.updateMatchFundLockStatus({
      matchId,
      status,
      updatedAt: new Date(),
    });
    return {
      ok: true,
      onChainMatchIdHex: lock.onChainMatchIdHex,
      txSignature: lock.lockTxSignature,
    };
  }
  if (probe.kind === "unknown") {
    return {
      ok: false,
      pending: true,
      onChainMatchIdHex: lock.onChainMatchIdHex,
      reason: `Chain state unknown: ${probe.error}`,
    };
  }

  // Absent — only release if we never submitted a lock tx, OR enough time passed and still absent.
  // If a signature was stored, wait longer (recovery) rather than free immediately on first absent read.
  return {
    ok: false,
    pending: Boolean(lock.lockTxSignature),
    onChainMatchIdHex: lock.onChainMatchIdHex,
    reason: lock.lockTxSignature
      ? "Lock tx submitted but match account not visible yet."
      : "No on-chain match account.",
  };
}

export async function settleMatchFunds(args: {
  matchId: string;
  onChainMatchIdHex?: string;
  players: Array<{
    playerIndex: number;
    walletAddress: string;
    alive: boolean;
    territoryCells: number;
  }>;
  totalCells: number;
}): Promise<{ ok: boolean; pending?: boolean; txSignature?: string; reason?: string }> {
  if (CONFIG.ESCROW.BYPASS) {
    return { ok: true, txSignature: "dev-bypass" };
  }

  if (!isEscrowProgramConfigured()) {
    return { ok: false, reason: "Escrow program is not configured." };
  }

  const lock = await db.findMatchFundLockByMatchId(args.matchId);
  const matchIdHex = args.onChainMatchIdHex ?? lock?.onChainMatchIdHex;
  if (!matchIdHex) {
    return { ok: false, reason: "No on-chain match lock found for settlement." };
  }

  const totalLocked = BigInt(lock?.totalBaseUnits ?? "0");
  if (totalLocked <= 0n) {
    return { ok: false, reason: "Match lock has zero total funds." };
  }

  if (lock?.status === "settled" || lock?.status === "forfeited") {
    return { ok: true, txSignature: lock.lockTxSignature };
  }

  // Reconcile chain before acting (handles landed-but-unconfirmed previous attempts).
  const chainProbe = await probeMatchEscrow(matchIdHex);
  if (chainProbe.kind === "exists" && chainProbe.escrow.status === "settled") {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "settled",
      updatedAt: new Date(),
    });
    return { ok: true };
  }
  if (chainProbe.kind === "exists" && chainProbe.escrow.status === "forfeited") {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "forfeited",
      updatedAt: new Date(),
    });
    return { ok: true };
  }
  const settlementProbe = await probeSettlementRecordExists(matchIdHex);
  if (settlementProbe.kind === "exists") {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "settled",
      updatedAt: new Date(),
    });
    return { ok: true };
  }
  if (chainProbe.kind === "unknown" || settlementProbe.kind === "unknown") {
    // Keep settling if already mid-flight; do not invent a new settle until chain is readable.
    if (lock?.status === "settling") {
      return {
        ok: false,
        pending: true,
        reason: "Settlement pending — chain state temporarily unreadable.",
      };
    }
  }

  const survivors = args.players.filter((p) => p.alive && p.territoryCells > 0);
  if (survivors.length === 0) {
    return forfeitMatchFunds({
      matchId: args.matchId,
      onChainMatchIdHex: matchIdHex,
      reasonCode: 1, // house claim / no survivors
    });
  }

  const totalCells = BigInt(args.totalCells);
  const payouts = survivors.map((p) => {
    const gross = (totalLocked * BigInt(p.territoryCells)) / totalCells;
    return {
      playerIndex: p.playerIndex,
      gross: gross > 0n ? gross : 1n,
      player: new PublicKey(p.walletAddress),
    };
  });

  // Ensure gross does not exceed pot due to rounding
  let sum = payouts.reduce((acc, p) => acc + p.gross, 0n);
  if (sum > totalLocked) {
    const overflow = sum - totalLocked;
    payouts[0].gross -= overflow;
    sum = totalLocked;
  }

  const filtered = payouts.filter((p) => p.gross > 0n);
  if (filtered.length === 0) {
    return forfeitMatchFunds({
      matchId: args.matchId,
      onChainMatchIdHex: matchIdHex,
      reasonCode: 2, // empty payout residual
    });
  }

  // Server-only result hash — never trust client-provided winners.
  const idempotencyKey = createHash("sha256").update(`settle:${args.matchId}`).digest();
  const resultHash = createHash("sha256")
    .update(
      JSON.stringify({
        matchId: args.matchId,
        totalCells: totalCells.toString(),
        totalLocked: totalLocked.toString(),
        payouts: filtered.map((p) => ({
          i: p.playerIndex,
          g: p.gross.toString(),
          w: p.player.toBase58(),
        })),
      }),
    )
    .digest();

  const now = new Date();
  const attempt = await db.insertSettlementAttempt({
    id: randomUUID(),
    matchId: args.matchId,
    idempotencyKey: idempotencyKey.toString("hex"),
    resultHash: resultHash.toString("hex"),
    payoutHash: createHash("sha256").update(resultHash).digest("hex"),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  if (attempt.status === "confirmed" && attempt.txSignature) {
    return { ok: true, txSignature: attempt.txSignature };
  }

  await db.updateMatchFundLockStatus({
    matchId: args.matchId,
    status: "settling",
    updatedAt: new Date(),
  });

  try {
    const matchIdBuf = Buffer.from(matchIdHex, "hex");
    const txSignature = await settleMatchOnChain({
      matchId: matchIdBuf,
      idempotencyKey,
      resultHash,
      payouts: filtered,
      onSubmitted: async (sig) => {
        await db.updateSettlementAttempt({
          id: attempt.id,
          status: "submitted",
          txSignature: sig,
          updatedAt: new Date(),
        });
      },
    });

    await db.updateSettlementAttempt({
      id: attempt.id,
      status: "confirmed",
      txSignature,
      updatedAt: new Date(),
    });
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "settled",
      updatedAt: new Date(),
    });
    console.info("[escrow] match settled", {
      matchId: args.matchId,
      onChainMatchIdHex: matchIdHex,
      txSignature,
      attemptId: attempt.id,
      recipientCount: filtered.length,
    });
    return { ok: true, txSignature };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement failed.";

    const matchProbe = await probeMatchEscrow(matchIdHex);
    const settleProbe = await probeSettlementRecordExists(matchIdHex);
    if (
      settleProbe.kind === "exists" ||
      (matchProbe.kind === "exists" && matchProbe.escrow.status === "settled")
    ) {
      await db.updateSettlementAttempt({
        id: attempt.id,
        status: "confirmed",
        updatedAt: new Date(),
      });
      await db.updateMatchFundLockStatus({
        matchId: args.matchId,
        status: "settled",
        updatedAt: new Date(),
      });
      console.warn("[escrow] settle confirm failed but on-chain settlement exists", {
        matchId: args.matchId,
        attemptId: attempt.id,
        reason: message,
      });
      return { ok: true };
    }

    if (matchProbe.kind === "unknown" || settleProbe.kind === "unknown") {
      // Stay settling — recovery will re-probe. Do not mark failed.
      await db.updateSettlementAttempt({
        id: attempt.id,
        status: "submitted",
        error: message,
        updatedAt: new Date(),
      });
      await db.updateMatchFundLockStatus({
        matchId: args.matchId,
        status: "settling",
        updatedAt: new Date(),
      });
      console.error("[escrow] settlement outcome UNKNOWN — leaving settling", {
        matchId: args.matchId,
        attemptId: attempt.id,
        reason: message,
      });
      return {
        ok: false,
        pending: true,
        reason: "Settlement pending confirmation until chain state is readable.",
      };
    }

    // Proven not settled — retriable failure.
    await db.updateSettlementAttempt({
      id: attempt.id,
      status: "failed",
      error: message,
      updatedAt: new Date(),
    });
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "locked",
      updatedAt: new Date(),
    });
    console.error("[escrow] settlement failed", {
      matchId: args.matchId,
      attemptId: attempt.id,
      reason: message,
    });
    return { ok: false, reason: message };
  }
}

export async function forfeitMatchFunds(args: {
  matchId: string;
  onChainMatchIdHex?: string;
  reasonCode?: number;
}): Promise<{ ok: boolean; pending?: boolean; txSignature?: string; reason?: string }> {
  if (CONFIG.ESCROW.BYPASS) {
    return { ok: true, txSignature: "dev-bypass-forfeit" };
  }
  if (!isEscrowProgramConfigured()) {
    return { ok: false, reason: "Escrow program is not configured." };
  }

  const lock = await db.findMatchFundLockByMatchId(args.matchId);
  const matchIdHex = args.onChainMatchIdHex ?? lock?.onChainMatchIdHex;
  if (!matchIdHex) {
    return { ok: false, reason: "No on-chain match lock found for forfeit." };
  }
  if (lock?.status === "forfeited" || lock?.status === "settled") {
    return { ok: true, txSignature: lock.lockTxSignature };
  }

  const chainBefore = await probeMatchEscrow(matchIdHex);
  if (chainBefore.kind === "exists" && chainBefore.escrow.status === "forfeited") {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "forfeited",
      updatedAt: new Date(),
    });
    return { ok: true };
  }
  if (chainBefore.kind === "exists" && chainBefore.escrow.status === "settled") {
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "settled",
      updatedAt: new Date(),
    });
    return { ok: true };
  }
  if (chainBefore.kind === "unknown" && lock?.status === "forfeiting") {
    return {
      ok: false,
      pending: true,
      reason: "Forfeit pending — chain state temporarily unreadable.",
    };
  }

  const idempotencyKey = createHash("sha256").update(`forfeit:${args.matchId}`).digest("hex");
  const now = new Date();
  const attempt = await db.insertSettlementAttempt({
    id: randomUUID(),
    matchId: args.matchId,
    idempotencyKey,
    resultHash: createHash("sha256").update(`forfeit-result:${args.matchId}`).digest("hex"),
    payoutHash: createHash("sha256").update(`forfeit-payout:${args.matchId}`).digest("hex"),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  if (attempt.status === "confirmed" && attempt.txSignature) {
    return { ok: true, txSignature: attempt.txSignature };
  }

  await db.updateMatchFundLockStatus({
    matchId: args.matchId,
    status: "forfeiting",
    updatedAt: new Date(),
  });

  try {
    const txSignature = await forfeitMatchOnChain({
      matchId: Buffer.from(matchIdHex, "hex"),
      reasonCode: args.reasonCode ?? 1,
      onSubmitted: async (sig) => {
        await db.updateSettlementAttempt({
          id: attempt.id,
          status: "submitted",
          txSignature: sig,
          updatedAt: new Date(),
        });
      },
    });
    await db.updateSettlementAttempt({
      id: attempt.id,
      status: "confirmed",
      txSignature,
      updatedAt: new Date(),
    });
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "forfeited",
      lockTxSignature: txSignature,
      updatedAt: new Date(),
    });
    console.info("[escrow] match forfeited to treasury", {
      matchId: args.matchId,
      onChainMatchIdHex: matchIdHex,
      txSignature,
      reasonCode: args.reasonCode ?? 1,
    });
    return { ok: true, txSignature };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Forfeit failed.";
    const chainAfter = await probeMatchEscrow(matchIdHex);
    if (chainAfter.kind === "exists" && chainAfter.escrow.status === "forfeited") {
      await db.updateSettlementAttempt({
        id: attempt.id,
        status: "confirmed",
        updatedAt: new Date(),
      });
      await db.updateMatchFundLockStatus({
        matchId: args.matchId,
        status: "forfeited",
        updatedAt: new Date(),
      });
      console.warn("[escrow] forfeit confirm failed but on-chain forfeited", {
        matchId: args.matchId,
        reason: message,
      });
      return { ok: true };
    }

    if (chainAfter.kind === "unknown") {
      await db.updateSettlementAttempt({
        id: attempt.id,
        status: "submitted",
        error: message,
        updatedAt: new Date(),
      });
      await db.updateMatchFundLockStatus({
        matchId: args.matchId,
        status: "forfeiting",
        updatedAt: new Date(),
      });
      console.error("[escrow] forfeit outcome UNKNOWN — leaving forfeiting", {
        matchId: args.matchId,
        reason: message,
        probeError: chainAfter.error,
      });
      return {
        ok: false,
        pending: true,
        reason: "Forfeit pending confirmation until chain state is readable.",
      };
    }

    await db.updateSettlementAttempt({
      id: attempt.id,
      status: "failed",
      error: message,
      updatedAt: new Date(),
    });
    await db.updateMatchFundLockStatus({
      matchId: args.matchId,
      status: "locked",
      updatedAt: new Date(),
    });
    console.error("[escrow] forfeit failed", { matchId: args.matchId, reason: message });
    return { ok: false, reason: message };
  }
}

/**
 * Recover incomplete escrow ops by reconciling chain first.
 * Handles: created (lock), settling, forfeiting.
 * Never releases deposits unless match PDA is proven absent.
 */
export async function recoverStuckEscrowLocks(options: { olderThanMs?: number } = {}) {
  const olderThanMs = options.olderThanMs ?? 90_000;
  const olderThan = new Date(Date.now() - olderThanMs);
  const stuck = await db.findStuckMatchFundLocks({
    statuses: ["created", "settling", "forfeiting"],
    olderThan,
    limit: 40,
  });
  let released = 0;
  let reconciled = 0;
  let deferred = 0;

  for (const lock of stuck) {
    if (!lock.onChainMatchIdHex) {
      deferred += 1;
      continue;
    }

    if (lock.status === "created") {
      const probe = await probeMatchEscrow(lock.onChainMatchIdHex);
      if (probe.kind === "exists") {
        const status =
          probe.escrow.status === "settled"
            ? "settled"
            : probe.escrow.status === "forfeited"
              ? "forfeited"
              : "locked";
        await db.updateMatchFundLockStatus({
          matchId: lock.matchId,
          status,
          updatedAt: new Date(),
        });
        reconciled += 1;
        console.warn("[escrow] recovery: lock reconciled from chain", {
          matchId: lock.matchId,
          status,
        });
        continue;
      }
      if (probe.kind === "unknown") {
        deferred += 1;
        console.warn("[escrow] recovery: lock probe unknown — holding", {
          matchId: lock.matchId,
          error: probe.error,
        });
        continue;
      }
      // Proven absent — release only after we are past the pending window.
      // If a lock tx was submitted, require older age (double window) before release.
      const submittedAgeMs = Date.now() - new Date(lock.updatedAt).getTime();
      const minAgeForRelease = lock.lockTxSignature ? olderThanMs * 2 : olderThanMs;
      if (submittedAgeMs < minAgeForRelease) {
        deferred += 1;
        continue;
      }
      const intents = await db.findDepositIntentsByMatchLock(lock.matchId);
      for (const intent of intents) {
        if (intent.status === "consumed") {
          await db.releaseConsumedDepositIntent({ id: intent.id, updatedAt: new Date() });
        }
      }
      await db.updateMatchFundLockStatus({
        matchId: lock.matchId,
        status: "failed",
        updatedAt: new Date(),
      });
      released += 1;
      console.warn("[escrow] recovery: released lock after proven-absent match", {
        matchId: lock.matchId,
        onChainMatchIdHex: lock.onChainMatchIdHex,
      });
      continue;
    }

    if (lock.status === "settling") {
      const matchProbe = await probeMatchEscrow(lock.onChainMatchIdHex);
      const settleProbe = await probeSettlementRecordExists(lock.onChainMatchIdHex);
      if (
        settleProbe.kind === "exists" ||
        (matchProbe.kind === "exists" && matchProbe.escrow.status === "settled")
      ) {
        await db.updateMatchFundLockStatus({
          matchId: lock.matchId,
          status: "settled",
          updatedAt: new Date(),
        });
        const attempts = await db.findSettlementAttemptsForMatch(lock.matchId);
        for (const a of attempts) {
          if (a.status === "submitted" || a.status === "pending" || a.status === "failed") {
            await db.updateSettlementAttempt({
              id: a.id,
              status: "confirmed",
              updatedAt: new Date(),
            });
          }
        }
        reconciled += 1;
        console.warn("[escrow] recovery: settlement reconciled from chain", {
          matchId: lock.matchId,
        });
        continue;
      }
      if (matchProbe.kind === "unknown" || settleProbe.kind === "unknown") {
        deferred += 1;
        continue;
      }
      // Proven not settled — reopen for retry (match still locked on-chain).
      if (matchProbe.kind === "exists" && matchProbe.escrow.status === "locked") {
        await db.updateMatchFundLockStatus({
          matchId: lock.matchId,
          status: "locked",
          updatedAt: new Date(),
        });
        reconciled += 1;
        console.warn("[escrow] recovery: settling → locked (not settled on-chain)", {
          matchId: lock.matchId,
        });
        continue;
      }
      deferred += 1;
      continue;
    }

    if (lock.status === "forfeiting") {
      const matchProbe = await probeMatchEscrow(lock.onChainMatchIdHex);
      if (matchProbe.kind === "exists" && matchProbe.escrow.status === "forfeited") {
        await db.updateMatchFundLockStatus({
          matchId: lock.matchId,
          status: "forfeited",
          updatedAt: new Date(),
        });
        const attempts = await db.findSettlementAttemptsForMatch(lock.matchId);
        for (const a of attempts) {
          if (a.status === "submitted" || a.status === "pending" || a.status === "failed") {
            await db.updateSettlementAttempt({
              id: a.id,
              status: "confirmed",
              updatedAt: new Date(),
            });
          }
        }
        reconciled += 1;
        console.warn("[escrow] recovery: forfeit reconciled from chain", {
          matchId: lock.matchId,
        });
        continue;
      }
      if (matchProbe.kind === "unknown") {
        deferred += 1;
        continue;
      }
      if (matchProbe.kind === "exists" && matchProbe.escrow.status === "locked") {
        await db.updateMatchFundLockStatus({
          matchId: lock.matchId,
          status: "locked",
          updatedAt: new Date(),
        });
        reconciled += 1;
        console.warn("[escrow] recovery: forfeiting → locked (forfeit not on-chain)", {
          matchId: lock.matchId,
        });
        continue;
      }
      deferred += 1;
    }
  }

  return { scanned: stuck.length, released, reconciled, deferred };
}

async function verifyDepositOnChain(args: {
  intent: DepositIntentDocument;
  wallet: WalletDocument;
  txSignature?: string;
}): Promise<DepositIntentDocument | null> {
  try {
    const program = getEscrowProgram();
    const onChain = await fetchDepositEscrow(args.intent.idempotencyKey);
    if (!onChain) {
      await db.updateDepositIntent({
        id: args.intent.id,
        verificationError: "Deposit escrow account not found on-chain yet.",
        updatedAt: new Date(),
      });
      return db.findDepositIntentById(args.intent.id);
    }

    const escrow = onChain.escrow;
    const expectedAmount = wagerAmountBaseUnits(
      Number(args.intent.wagerUsd),
      program.tokenDecimals,
    );

    if (!escrow.player.equals(new PublicKey(args.wallet.address))) {
      await markFailed(args.intent.id, "Deposit player does not match wallet.");
      return db.findDepositIntentById(args.intent.id);
    }
    if (!escrow.tokenMint.equals(program.tokenMint)) {
      await markFailed(args.intent.id, "Deposit uses the wrong token mint.");
      return db.findDepositIntentById(args.intent.id);
    }
    if (escrow.amount !== expectedAmount) {
      await markFailed(args.intent.id, "Deposit amount does not match wager tier.");
      return db.findDepositIntentById(args.intent.id);
    }
    if (escrow.arena !== args.intent.arena) {
      await markFailed(args.intent.id, "Deposit arena does not match intent.");
      return db.findDepositIntentById(args.intent.id);
    }
    if (escrow.wagerTierUsd !== Number(args.intent.wagerUsd)) {
      await markFailed(args.intent.id, "Deposit wager tier does not match intent.");
      return db.findDepositIntentById(args.intent.id);
    }
    if (escrow.status !== DEPOSIT_STATUS.Funded) {
      await markFailed(args.intent.id, "Deposit is not in funded state.");
      return db.findDepositIntentById(args.intent.id);
    }

    const now = new Date();
    const expiresAtMs = Number(escrow.expiresAt) * 1000;
    if (expiresAtMs <= now.getTime()) {
      await markFailed(args.intent.id, "On-chain deposit has expired.");
      return db.findDepositIntentById(args.intent.id);
    }

    await db.updateDepositIntent({
      id: args.intent.id,
      status: "verified",
      txSignature: args.txSignature ?? args.intent.txSignature,
      verifiedAt: now,
      verificationError: null,
      tokenMint: program.tokenMint.toBase58(),
      tokenSymbol: program.tokenSymbol,
      amountBaseUnits: escrow.amount.toString(),
      updatedAt: now,
    });
    return db.findDepositIntentById(args.intent.id);
  } catch (error) {
    await db.updateDepositIntent({
      id: args.intent.id,
      verificationError: error instanceof Error ? error.message : "Deposit verification failed.",
      updatedAt: new Date(),
    });
    return db.findDepositIntentById(args.intent.id);
  }
}

async function markFailed(id: string, reason: string) {
  await db.updateDepositIntent({
    id,
    status: "failed",
    verificationError: reason,
    updatedAt: new Date(),
  });
}

function publicDepositIntent(
  intent: DepositIntentDocument,
  playerAddress?: string,
): PublicDepositIntent {
  const runtime = withRuntimeStatus(intent);
  const base: PublicDepositIntent = {
    id: runtime.id,
    arena: runtime.arena,
    wagerUsd: runtime.wagerUsd,
    status: runtime.status,
    contractStatus: runtime.contractStatus,
    tokenSymbol: runtime.tokenSymbol,
    tokenMint: runtime.tokenMint,
    amountBaseUnits: runtime.amountBaseUnits,
    onChainIntentId: runtime.idempotencyKey,
    txSignature: runtime.txSignature,
    verificationError: runtime.verificationError,
    expiresAt: runtime.expiresAt.toISOString(),
    verifiedAt: runtime.verifiedAt?.toISOString(),
    consumedAt: runtime.consumedAt?.toISOString(),
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  };

  if (
    isEscrowProgramConfigured() &&
    playerAddress &&
    (runtime.status === "awaiting_payment" || runtime.status === "submitted")
  ) {
    base.build = publicDepositBuildParams({
      intentIdHex: runtime.idempotencyKey,
      arena: runtime.arena,
      wagerUsd: Number(runtime.wagerUsd),
      expiresAt: runtime.expiresAt,
      player: playerAddress,
    });
  }

  return base;
}

function withRuntimeStatus(intent: DepositIntentDocument): DepositIntentDocument {
  if (
    intent.expiresAt <= new Date() &&
    !["verified", "consumed", "refunded", "forfeited", "failed"].includes(intent.status)
  ) {
    return { ...intent, status: "expired" };
  }
  return intent;
}

function assertSupportedWager(wager: WagerAmount) {
  if (!CONFIG.WAGERS.includes(wager)) {
    throw new Error("Unsupported wager tier.");
  }
}

function wagerToUsd(wager: WagerAmount) {
  return Number(wager).toFixed(2);
}
