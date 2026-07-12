/**
 * Mint PaperArena devnet wager tokens to a wallet.
 *
 * Usage (from contract/):
 *   npx tsx scripts/mint-devnet-tokens.ts <RECIPIENT_PUBKEY> [AMOUNT_UI]
 *
 * Example:
 *   npx tsx scripts/mint-devnet-tokens.ts YourPhantomDevnetAddress 100
 *
 * Authority: set ESCROW_GAME_AUTHORITY_SECRET in env, or pass path to keypair JSON:
 *   GAME_AUTHORITY_KEYPAIR=C:\path\id.json npx tsx scripts/mint-devnet-tokens.ts ...
 */
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "fs";

const MINT = new PublicKey("4LUhzrjpWJurTWRKGE3WKKtYV267e5qNvuBoKSBqBwUd");
const DECIMALS = 6;
const RPC =
  process.env.SOLANA_DEVNET_RPC_URL ??
  process.env.SOLANA_RPC_URL ??
  clusterApiUrl("devnet");

function loadAuthority(): Keypair {
  const path = process.env.GAME_AUTHORITY_KEYPAIR ?? process.env.ESCROW_GAME_AUTHORITY_KEYPAIR_PATH;
  if (path) {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const secret =
    process.env.ESCROW_GAME_AUTHORITY_SECRET ??
    process.env.GAME_AUTHORITY_SECRET;
  if (!secret) {
    throw new Error(
      "Set ESCROW_GAME_AUTHORITY_SECRET (base58) or GAME_AUTHORITY_KEYPAIR path.",
    );
  }
  if (secret.trim().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

async function main() {
  const recipientStr = process.argv[2];
  const amountUi = Number(process.argv[3] ?? "100");
  if (!recipientStr) {
    console.error("Usage: npx tsx scripts/mint-devnet-tokens.ts <RECIPIENT> [AMOUNT]");
    process.exit(1);
  }
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    throw new Error("AMOUNT must be a positive number (UI units, e.g. 100).");
  }

  const authority = loadAuthority();
  const recipient = new PublicKey(recipientStr);
  const connection = new Connection(RPC, "confirmed");
  const rawAmount = BigInt(Math.round(amountUi * 10 ** DECIMALS));

  console.log("RPC:", RPC);
  console.log("Mint:", MINT.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", amountUi, "tokens (", rawAmount.toString(), "base units)");

  const bal = await connection.getBalance(authority.publicKey);
  if (bal < 50_000) {
    throw new Error(
      "Authority has almost no SOL for fees. Airdrop SOL to " +
        authority.publicKey.toBase58() +
        " on devnet first.",
    );
  }

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    MINT,
    recipient,
  );
  console.log("Recipient ATA:", ata.address.toBase58());

  const sig = await mintTo(
    connection,
    authority,
    MINT,
    ata.address,
    authority,
    rawAmount,
  );
  console.log("mintTo tx:", sig);
  console.log("Done. Refresh PaperArena wallet balance.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
