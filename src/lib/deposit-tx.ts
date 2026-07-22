import { Buffer } from "./buffer-polyfill";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { DepositBuildParams } from "./deposit";
import { SOLANA_CONFIG } from "./solana-config";

// Anchor: sha256("global:deposit")[0..8]
const DEPOSIT_DISCRIMINATOR = Buffer.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]);

async function depositDiscriminator(): Promise<Buffer> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:deposit"));
    return Buffer.from(hash).subarray(0, 8);
  }
  return DEPOSIT_DISCRIMINATOR;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, "");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function writeU64LE(buf: Buffer, offset: number, value: bigint) {
  buf.writeBigUInt64LE(value, offset);
}

function writeI64LE(buf: Buffer, offset: number, value: bigint) {
  buf.writeBigInt64LE(value, offset);
}

function isBlockhashError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /blockhash not found|block height exceeded|expired/i.test(msg);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until processed/confirmed — real chain status, not a fake success. */
async function waitForSig(
  connection: Connection,
  signature: string,
  timeoutMs = 12_000,
): Promise<"ok" | "err" | "unknown"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const st = statuses.value[0];
      if (st?.err) return "err";
      if (
        st?.confirmationStatus === "processed" ||
        st?.confirmationStatus === "confirmed" ||
        st?.confirmationStatus === "finalized"
      ) {
        return "ok";
      }
    } catch {
      /* keep polling */
    }
    await sleep(250);
  }
  return "unknown";
}

export async function sendDepositTransaction(args: {
  build: DepositBuildParams;
  playerPublicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}): Promise<string> {
  const connection = new Connection(SOLANA_CONFIG.rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 12_000,
  });
  const programId = new PublicKey(args.build.programId);
  const configPda = new PublicKey(args.build.configPda);
  const vaultPda = new PublicKey(args.build.vaultPda);
  const tokenMint = new PublicKey(args.build.tokenMint);
  const depositPdaKey = new PublicKey(args.build.depositPda);
  const playerAta = getAssociatedTokenAddressSync(tokenMint, args.playerPublicKey, false);

  const intentId = hexToBytes(args.build.onChainIntentId);
  const amount = BigInt(args.build.amountBaseUnits);
  const disc = await depositDiscriminator();

  const data = Buffer.alloc(8 + 32 + 8 + 1 + 1 + 8);
  disc.copy(data, 0);
  Buffer.from(intentId).copy(data, 8);
  writeU64LE(data, 40, amount);
  data[48] = args.build.arena === "mega" ? 1 : 0;
  data[49] = args.build.wagerTierUsd;
  writeI64LE(data, 50, BigInt(args.build.expiresAtUnix));

  const depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.playerPublicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: depositPdaKey, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          args.playerPublicKey,
          playerAta,
          args.playerPublicKey,
          tokenMint,
        ),
        depositIx,
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = args.playerPublicKey;
      tx.recentBlockhash = blockhash;

      const signed = await args.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2,
      });

      const landed = await waitForSig(connection, signature, 12_000);
      if (landed === "ok") return signature;
      if (landed === "err") {
        throw new Error("Deposit transaction failed on-chain.");
      }

      // One more deep check before failing.
      const txInfo = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo && !txInfo.meta?.err) return signature;
      throw new Error("Deposit confirmation timed out. Check explorer before retrying.");
    } catch (error) {
      lastError = error;
      if (attempt < 2 && isBlockhashError(error)) continue;
      throw error instanceof Error
        ? error
        : new Error("Deposit transaction failed. Please try again.");
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Deposit transaction failed. Please try again.");
}
