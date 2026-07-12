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

export async function sendDepositTransaction(args: {
  build: DepositBuildParams;
  playerPublicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}): Promise<string> {
  const connection = new Connection(SOLANA_CONFIG.rpcUrl, "confirmed");
  const programId = new PublicKey(args.build.programId);
  const configPda = new PublicKey(args.build.configPda);
  const vaultPda = new PublicKey(args.build.vaultPda);
  const tokenMint = new PublicKey(args.build.tokenMint);
  const depositPda = new PublicKey(args.build.depositPda);
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
      { pubkey: depositPda, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      args.playerPublicKey,
      playerAta,
      args.playerPublicKey,
      tokenMint,
    ),
    depositIx,
  );

  // Fresh blockhash immediately before sign+send (wallet UI delay can burn old ones).
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.playerPublicKey;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  const signed = await args.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });

  // If confirm throws "block height exceeded", the tx may still have landed.
  // Always check signature status before treating it as a hard failure.
  try {
    const conf = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (conf.value.err) {
      throw new Error(`Deposit transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
    }
  } catch (error) {
    const statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];
    if (status?.err) {
      throw new Error(`Deposit transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    // Last resort: fetch parsed tx
    const txInfo = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txInfo && !txInfo.meta?.err) {
      return signature;
    }
    throw error instanceof Error
      ? error
      : new Error("Deposit confirmation timed out. Check explorer before retrying.");
  }

  return signature;
}
