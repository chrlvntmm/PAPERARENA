import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { CONFIG } from "../config.js";

export const DEPOSIT_STATUS = {
  Funded: 0,
  Consumed: 1,
  Refunded: 2,
} as const;

export const ARENA_ONCHAIN = {
  standard: 0,
  mega: 1,
} as const;

export type OnChainArena = keyof typeof ARENA_ONCHAIN;

export interface OnChainDepositEscrow {
  intentId: Buffer;
  player: PublicKey;
  tokenMint: PublicKey;
  amount: bigint;
  arena: OnChainArena;
  wagerTierUsd: number;
  status: number;
  expiresAt: bigint;
  createdAt: bigint;
  matchId: Buffer;
  bump: number;
}

export interface EscrowProgramConfig {
  programId: PublicKey;
  tokenMint: PublicKey;
  treasuryTokenAccount: PublicKey;
  tokenSymbol: string;
  tokenDecimals: number;
  configPda: PublicKey;
  vaultPda: PublicKey;
  connection: Connection;
  gameAuthority: Keypair | null;
}

function requireEscrowEnv(): EscrowProgramConfig {
  const programIdRaw = CONFIG.ESCROW.PROGRAM_ID;
  const mintRaw = CONFIG.ESCROW.TOKEN_MINT;
  const treasuryRaw = CONFIG.ESCROW.TREASURY_TOKEN_ACCOUNT;
  if (!programIdRaw || !mintRaw || !treasuryRaw) {
    throw new Error("Escrow program is not fully configured in environment.");
  }

  const programId = new PublicKey(programIdRaw);
  const tokenMint = new PublicKey(mintRaw);
  const treasuryTokenAccount = new PublicKey(treasuryRaw);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], programId);

  return {
    programId,
    tokenMint,
    treasuryTokenAccount,
    tokenSymbol: CONFIG.ESCROW.TOKEN_SYMBOL,
    tokenDecimals: CONFIG.ESCROW.TOKEN_DECIMALS,
    configPda,
    vaultPda,
    connection: new Connection(CONFIG.RPC.SOLANA_URL, "confirmed"),
    gameAuthority: loadGameAuthority(),
  };
}

let cachedConfig: EscrowProgramConfig | null | undefined;

export function isEscrowProgramConfigured(): boolean {
  return Boolean(
    CONFIG.ESCROW.PROGRAM_ID &&
      CONFIG.ESCROW.TOKEN_MINT &&
      CONFIG.ESCROW.TREASURY_TOKEN_ACCOUNT,
  );
}

export function getEscrowProgram(): EscrowProgramConfig {
  if (cachedConfig === undefined) {
    cachedConfig = isEscrowProgramConfigured() ? requireEscrowEnv() : null;
  }
  if (!cachedConfig) {
    throw new Error("Escrow program is not configured.");
  }
  return cachedConfig;
}

export function resetEscrowProgramCache() {
  cachedConfig = undefined;
}

function loadGameAuthority(): Keypair | null {
  const path = CONFIG.ESCROW.GAME_AUTHORITY_KEYPAIR_PATH;
  const raw = CONFIG.ESCROW.GAME_AUTHORITY_SECRET;

  try {
    if (path) {
      const fileRaw = readFileSync(path, "utf8").trim();
      if (fileRaw.startsWith("[")) {
        const bytes = JSON.parse(fileRaw) as number[];
        return Keypair.fromSecretKey(Uint8Array.from(bytes));
      }
      return Keypair.fromSecretKey(bs58.decode(fileRaw));
    }

    if (!raw) return null;

    if (raw.trim().startsWith("[")) {
      const bytes = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    // base58 secret key
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch (error) {
    throw new Error(
      `Invalid game authority key (ESCROW_GAME_AUTHORITY_SECRET or ESCROW_GAME_AUTHORITY_KEYPAIR_PATH): ${
        error instanceof Error ? error.message : "parse failed"
      }`,
    );
  }
}

export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function randomIntentId(): Buffer {
  return randomBytes(32);
}

export function randomMatchId(): Buffer {
  return randomBytes(32);
}

export function intentIdToHex(intentId: Buffer): string {
  return intentId.toString("hex");
}

export function intentIdFromHex(hex: string): Buffer {
  const cleaned = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new Error("On-chain intent id must be 32 bytes hex.");
  }
  return Buffer.from(cleaned, "hex");
}

export function depositPda(programId: PublicKey, intentId: Buffer): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), intentId],
    programId,
  );
  return pda;
}

export function matchPda(programId: PublicKey, matchId: Buffer): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("match"), matchId], programId);
  return pda;
}

export function settlementPda(programId: PublicKey, matchId: Buffer): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), matchId],
    programId,
  );
  return pda;
}

export function wagerAmountBaseUnits(wagerUsd: number, decimals: number): bigint {
  if (!Number.isInteger(wagerUsd) || wagerUsd <= 0) {
    throw new Error("Invalid wager tier.");
  }
  let unit = 1n;
  for (let i = 0; i < decimals; i++) unit *= 10n;
  return BigInt(wagerUsd) * unit;
}

export function decodeDepositEscrow(data: Buffer): OnChainDepositEscrow {
  if (data.length < 8 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8 + 8 + 32 + 1) {
    throw new Error("Deposit escrow account data is too short.");
  }
  let o = 8; // skip discriminator
  const intentId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const player = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const tokenMint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const amount = data.readBigUInt64LE(o);
  o += 8;
  const arenaRaw = data.readUInt8(o++);
  const wagerTierUsd = data.readUInt8(o++);
  const status = data.readUInt8(o++);
  const expiresAt = data.readBigInt64LE(o);
  o += 8;
  const createdAt = data.readBigInt64LE(o);
  o += 8;
  const matchId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const bump = data.readUInt8(o);

  const arena: OnChainArena = arenaRaw === 1 ? "mega" : "standard";
  return {
    intentId,
    player,
    tokenMint,
    amount,
    arena,
    wagerTierUsd,
    status,
    expiresAt,
    createdAt,
    matchId,
    bump,
  };
}

export async function fetchDepositEscrow(
  intentIdHex: string,
): Promise<{ pubkey: PublicKey; escrow: OnChainDepositEscrow } | null> {
  const program = getEscrowProgram();
  const intentId = intentIdFromHex(intentIdHex);
  const pubkey = depositPda(program.programId, intentId);
  const info = await program.connection.getAccountInfo(pubkey, "confirmed");
  if (!info || !info.owner.equals(program.programId)) return null;
  return { pubkey, escrow: decodeDepositEscrow(Buffer.from(info.data)) };
}

export type OnChainMatchStatus = "locked" | "settled" | "refunded" | "forfeited";

export interface OnChainMatchEscrow {
  matchId: Buffer;
  arena: OnChainArena;
  wagerTierUsd: number;
  tokenMint: PublicKey;
  totalLocked: bigint;
  players: PublicKey[];
  refundedCount: number;
  status: OnChainMatchStatus;
  resultHash: Buffer;
  lockedAt: bigint;
  bump: number;
}

const MATCH_STATUS_BY_U8: OnChainMatchStatus[] = ["locked", "settled", "refunded", "forfeited"];

export function decodeMatchEscrow(data: Buffer): OnChainMatchEscrow {
  // 8 disc + 32 match_id + 1 arena + 1 wager + 32 mint + 8 total + 4 vec_len + players + 1 + 1 + 32 + 8 + 1
  if (data.length < 8 + 32 + 1 + 1 + 32 + 8 + 4 + 1 + 1 + 32 + 8 + 1) {
    throw new Error("Match escrow account data is too short.");
  }
  let o = 8;
  const matchId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const arenaRaw = data.readUInt8(o++);
  const wagerTierUsd = data.readUInt8(o++);
  const tokenMint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const totalLocked = data.readBigUInt64LE(o);
  o += 8;
  const playerCount = data.readUInt32LE(o);
  o += 4;
  if (playerCount > 10 || data.length < o + playerCount * 32 + 1 + 1 + 32 + 8 + 1) {
    throw new Error("Match escrow player list is invalid.");
  }
  const players: PublicKey[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const refundedCount = data.readUInt8(o++);
  const statusRaw = data.readUInt8(o++);
  const resultHash = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const lockedAt = data.readBigInt64LE(o);
  o += 8;
  const bump = data.readUInt8(o);
  const status = MATCH_STATUS_BY_U8[statusRaw];
  if (!status) throw new Error(`Unknown match status discriminant: ${statusRaw}`);
  return {
    matchId,
    arena: arenaRaw === 1 ? "mega" : "standard",
    wagerTierUsd,
    tokenMint,
    totalLocked,
    players,
    refundedCount,
    status,
    resultHash,
    lockedAt,
    bump,
  };
}

/** Read on-chain match escrow by 32-byte match id hex. Null if account does not exist. */
export async function fetchMatchEscrow(
  matchIdHex: string,
): Promise<{ pubkey: PublicKey; escrow: OnChainMatchEscrow } | null> {
  const program = getEscrowProgram();
  const matchId = intentIdFromHex(matchIdHex);
  const pubkey = matchPda(program.programId, matchId);
  const info = await program.connection.getAccountInfo(pubkey, "confirmed");
  if (!info || !info.owner.equals(program.programId) || info.data.length < 16) {
    return null;
  }
  return { pubkey, escrow: decodeMatchEscrow(Buffer.from(info.data)) };
}

/**
 * Distinguishes "account missing" from "RPC/read failed".
 * Callers must NOT release deposits on `unknown`.
 */
export async function probeMatchEscrow(matchIdHex: string): Promise<
  | { kind: "exists"; escrow: OnChainMatchEscrow; pubkey: PublicKey }
  | { kind: "absent" }
  | { kind: "unknown"; error: string }
> {
  try {
    const result = await fetchMatchEscrow(matchIdHex);
    if (!result) return { kind: "absent" };
    return { kind: "exists", escrow: result.escrow, pubkey: result.pubkey };
  } catch (error) {
    return {
      kind: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Settlement PDA exists only after a successful settle_match. */
export async function fetchSettlementRecordExists(matchIdHex: string): Promise<boolean> {
  const program = getEscrowProgram();
  const matchId = intentIdFromHex(matchIdHex);
  const pubkey = settlementPda(program.programId, matchId);
  const info = await program.connection.getAccountInfo(pubkey, "confirmed");
  return Boolean(info && info.owner.equals(program.programId) && info.data.length > 8);
}

export async function probeSettlementRecordExists(
  matchIdHex: string,
): Promise<{ kind: "exists" } | { kind: "absent" } | { kind: "unknown"; error: string }> {
  try {
    const exists = await fetchSettlementRecordExists(matchIdHex);
    return exists ? { kind: "exists" } : { kind: "absent" };
  } catch (error) {
    return {
      kind: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildDepositInstruction(args: {
  player: PublicKey;
  intentId: Buffer;
  amount: bigint;
  arena: OnChainArena;
  wagerTierUsd: number;
  expiresAtUnix: number;
  playerTokenAccount: PublicKey;
}): TransactionInstruction {
  const program = getEscrowProgram();
  const data = Buffer.alloc(8 + 32 + 8 + 1 + 1 + 8);
  let o = 0;
  anchorDiscriminator("deposit").copy(data, o);
  o += 8;
  args.intentId.copy(data, o);
  o += 32;
  data.writeBigUInt64LE(args.amount, o);
  o += 8;
  data.writeUInt8(ARENA_ONCHAIN[args.arena], o++);
  data.writeUInt8(args.wagerTierUsd, o++);
  data.writeBigInt64LE(BigInt(args.expiresAtUnix), o);

  const depositEscrow = depositPda(program.programId, args.intentId);

  return new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: args.player, isSigner: true, isWritable: true },
      { pubkey: program.configPda, isSigner: false, isWritable: false },
      { pubkey: depositEscrow, isSigner: false, isWritable: true },
      { pubkey: program.tokenMint, isSigner: false, isWritable: false },
      { pubkey: args.playerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: program.vaultPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Resilient authority send: fresh blockhash, and does not fail if the tx
 * actually landed after a "block height exceeded" confirm race (common on devnet RPC).
 * Only re-sends if the previous signature never appeared on-chain.
 */
async function sendAndConfirmAuthorityTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
  onSubmitted?: (signature: string) => Promise<void> | void,
): Promise<string> {
  const feePayer = signers[0];
  if (!feePayer) throw new Error(`${label}: missing fee payer signer.`);

  let lastError: unknown;
  let signature: string | undefined;
  let submittedHookFired = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!signature) {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("finalized");
        // Clone instructions into a fresh tx each send (avoids stale signature state).
        const fresh = new Transaction();
        for (const ix of tx.instructions) fresh.add(ix);
        fresh.feePayer = feePayer.publicKey;
        fresh.recentBlockhash = blockhash;
        fresh.lastValidBlockHeight = lastValidBlockHeight;
        fresh.partialSign(...signers);

        signature = await connection.sendRawTransaction(fresh.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 5,
        });
        console.info(`[escrow] ${label} submitted`, { signature, attempt });

        // Persist signature before confirm wait so recovery can reconcile.
        if (onSubmitted && !submittedHookFired) {
          submittedHookFired = true;
          await onSubmitted(signature);
        }

        try {
          const conf = await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            "confirmed",
          );
          if (conf.value.err) {
            throw new Error(`${label} failed on-chain: ${JSON.stringify(conf.value.err)}`);
          }
          return signature;
        } catch (confirmError) {
          lastError = confirmError;
        }
      }

      // confirmTransaction often throws "block height exceeded" even when the tx landed.
      const landed = await waitForSignatureLanded(connection, signature, 25_000);
      if (landed === "ok") {
        console.info(`[escrow] ${label} confirmed via status poll`, { signature });
        return signature;
      }
      if (landed === "err") {
        throw new Error(`${label} failed on-chain (signature ${signature}).`);
      }

      console.warn(`[escrow] ${label} signature not found yet; will re-send`, {
        signature,
        attempt,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      signature = undefined;
      submittedHookFired = false;
      await sleep(500 * attempt);
    } catch (error) {
      lastError = error;
      console.warn(`[escrow] ${label} attempt ${attempt} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep signature if we already submitted — next loop polls it first.
      if (!signature) {
        await sleep(500 * attempt);
      } else {
        const landed = await waitForSignatureLanded(connection, signature, 8_000);
        if (landed === "ok") return signature;
        if (landed === "err") {
          signature = undefined;
          submittedHookFired = false;
        }
        await sleep(500 * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after retries.`);
}

async function waitForSignatureLanded(
  connection: Connection,
  signature: string,
  timeoutMs: number,
): Promise<"ok" | "err" | "unknown"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];
    if (status?.err) return "err";
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return "ok";
    }
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      return tx.meta?.err ? "err" : "ok";
    }
    await sleep(500);
  }
  return "unknown";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function lockMatchOnChain(args: {
  matchId: Buffer;
  depositIntentHexes: string[];
  onSubmitted?: (signature: string) => Promise<void> | void;
}): Promise<string> {
  const program = getEscrowProgram();
  if (!program.gameAuthority) {
    throw new Error("ESCROW_GAME_AUTHORITY_SECRET is required to lock matches.");
  }

  const data = Buffer.alloc(8 + 32);
  anchorDiscriminator("lock_match").copy(data, 0);
  args.matchId.copy(data, 8);

  const matchEscrow = matchPda(program.programId, args.matchId);
  const remaining = args.depositIntentHexes.map((hex) => ({
    pubkey: depositPda(program.programId, intentIdFromHex(hex)),
    isSigner: false,
    isWritable: true,
  }));

  const ix = new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: program.gameAuthority.publicKey, isSigner: true, isWritable: true },
      { pubkey: program.configPda, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  return sendAndConfirmAuthorityTx(
    program.connection,
    tx,
    [program.gameAuthority],
    "lock_match",
    args.onSubmitted,
  );
}

/** House claim / no-survivor path: transfer entire locked pot to treasury. */
export async function forfeitMatchOnChain(args: {
  matchId: Buffer;
  reasonCode?: number;
  onSubmitted?: (signature: string) => Promise<void> | void;
}): Promise<string> {
  const program = getEscrowProgram();
  if (!program.gameAuthority) {
    throw new Error("ESCROW_GAME_AUTHORITY_SECRET is required to forfeit matches.");
  }

  const data = Buffer.alloc(8 + 1);
  anchorDiscriminator("forfeit").copy(data, 0);
  data.writeUInt8(args.reasonCode ?? 1, 8);

  const matchEscrow = matchPda(program.programId, args.matchId);
  const ix = new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: program.gameAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: program.configPda, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: program.vaultPda, isSigner: false, isWritable: true },
      { pubkey: program.treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  return sendAndConfirmAuthorityTx(
    program.connection,
    tx,
    [program.gameAuthority],
    "forfeit",
    args.onSubmitted,
  );
}

export async function settleMatchOnChain(args: {
  matchId: Buffer;
  idempotencyKey: Buffer;
  resultHash: Buffer;
  payouts: Array<{ playerIndex: number; gross: bigint; player: PublicKey }>;
  onSubmitted?: (signature: string) => Promise<void> | void;
}): Promise<string> {
  const program = getEscrowProgram();
  if (!program.gameAuthority) {
    throw new Error("ESCROW_GAME_AUTHORITY_SECRET is required to settle matches.");
  }

  const payoutBody = Buffer.alloc(4 + args.payouts.length * (1 + 8));
  payoutBody.writeUInt32LE(args.payouts.length, 0);
  let po = 4;
  for (const payout of args.payouts) {
    payoutBody.writeUInt8(payout.playerIndex, po++);
    payoutBody.writeBigUInt64LE(payout.gross, po);
    po += 8;
  }

  const data = Buffer.concat([
    anchorDiscriminator("settle_match"),
    args.matchId,
    args.idempotencyKey,
    args.resultHash,
    payoutBody,
  ]);

  const matchEscrow = matchPda(program.programId, args.matchId);
  const settlementRecord = settlementPda(program.programId, args.matchId);

  const authority = program.gameAuthority;
  const preIxs: TransactionInstruction[] = [];
  const recipientMetas = [];

  for (const payout of args.payouts) {
    const ata = getAssociatedTokenAddressSync(program.tokenMint, payout.player, false);
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        ata,
        payout.player,
        program.tokenMint,
      ),
    );
    recipientMetas.push({ pubkey: ata, isSigner: false, isWritable: true });
  }

  const settleIx = new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: program.configPda, isSigner: false, isWritable: false },
      { pubkey: matchEscrow, isSigner: false, isWritable: true },
      { pubkey: settlementRecord, isSigner: false, isWritable: true },
      { pubkey: program.vaultPda, isSigner: false, isWritable: true },
      { pubkey: program.treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...recipientMetas,
    ],
    data,
  });

  const tx = new Transaction().add(...preIxs, settleIx);
  return sendAndConfirmAuthorityTx(
    program.connection,
    tx,
    [authority],
    "settle_match",
    args.onSubmitted,
  );
}

export function publicDepositBuildParams(args: {
  intentIdHex: string;
  arena: OnChainArena;
  wagerUsd: number;
  expiresAt: Date;
  player: string;
}) {
  const program = getEscrowProgram();
  const intentId = intentIdFromHex(args.intentIdHex);
  const amount = wagerAmountBaseUnits(args.wagerUsd, program.tokenDecimals);
  const playerPk = new PublicKey(args.player);
  const playerTokenAccount = getAssociatedTokenAddressSync(program.tokenMint, playerPk, false);
  const depositEscrow = depositPda(program.programId, intentId);

  return {
    programId: program.programId.toBase58(),
    configPda: program.configPda.toBase58(),
    vaultPda: program.vaultPda.toBase58(),
    tokenMint: program.tokenMint.toBase58(),
    tokenSymbol: program.tokenSymbol,
    tokenDecimals: program.tokenDecimals,
    amountBaseUnits: amount.toString(),
    onChainIntentId: args.intentIdHex,
    depositPda: depositEscrow.toBase58(),
    playerTokenAccount: playerTokenAccount.toBase58(),
    arena: args.arena,
    wagerTierUsd: args.wagerUsd,
    expiresAtUnix: Math.floor(args.expiresAt.getTime() / 1000),
    cluster: CONFIG.RPC.SOLANA_CLUSTER,
  };
}
