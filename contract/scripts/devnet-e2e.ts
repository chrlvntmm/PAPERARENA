import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import crypto from "crypto";

const RPC = "https://api.devnet.solana.com";
const MINT = new PublicKey("4LUhzrjpWJurTWRKGE3WKKtYV267e5qNvuBoKSBqBwUd");
const TREASURY = new PublicKey("C82i2y5aji1cp1cCg5V7DqFhy7d3uSZJuFixC99K2Kt3");
const USD5 = 5_000_000;

function loadWallet(): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function rand32(): number[] {
  return [...crypto.randomBytes(32)];
}

async function main() {
  const wallet = loadWallet();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/paperarena.json", "utf-8")
  );
  const program = new anchor.Program(idl, provider);
  const programId = program.programId;
  console.log("program:", programId.toBase58());

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    programId
  );

  const configInfo = await connection.getAccountInfo(config);
  if (!configInfo) {
    const sig = await program.methods
      .initializeConfig(wallet.publicKey, 200, new anchor.BN(3600))
      .accountsPartial({
        admin: wallet.publicKey,
        config,
        tokenMint: MINT,
        vault,
        treasuryTokenAccount: TREASURY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("initialize_config:", sig);
  } else {
    console.log("config already initialized");
  }

  const players: { kp: Keypair; ata: PublicKey; depositPda: PublicKey }[] = [];
  for (let i = 0; i < 2; i++) {
    const kp = Keypair.generate();
    const fund = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: kp.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(fund));
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      MINT,
      kp.publicKey
    );
    await mintTo(connection, wallet, MINT, ata.address, wallet, USD5);
    players.push({ kp, ata: ata.address, depositPda: PublicKey.default });
    console.log(`player ${i + 1}:`, kp.publicKey.toBase58());
  }

  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 900);
  for (const p of players) {
    const intentId = rand32();
    const [depositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), Buffer.from(intentId)],
      programId
    );
    p.depositPda = depositPda;
    const sig = await program.methods
      .deposit(intentId, new anchor.BN(USD5), { standard: {} }, 5, expiresAt)
      .accountsPartial({
        player: p.kp.publicKey,
        config,
        depositEscrow: depositPda,
        tokenMint: MINT,
        playerTokenAccount: p.ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([p.kp])
      .rpc();
    console.log("deposit:", sig);
  }

  const matchId = rand32();
  const [matchPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), Buffer.from(matchId)],
    programId
  );
  const lockSig = await program.methods
    .lockMatch(matchId)
    .accountsPartial({
      gameAuthority: wallet.publicKey,
      config,
      matchEscrow: matchPda,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      players.map((p) => ({
        pubkey: p.depositPda,
        isWritable: true,
        isSigner: false,
      }))
    )
    .rpc();
  console.log("lock_match:", lockSig);

  const [settlementPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), Buffer.from(matchId)],
    programId
  );
  const settleSig = await program.methods
    .settleMatch(matchId, rand32(), rand32(), [
      { playerIndex: 0, gross: new anchor.BN(USD5 * 2) },
    ])
    .accountsPartial({
      gameAuthority: wallet.publicKey,
      config,
      matchEscrow: matchPda,
      settlementRecord: settlementPda,
      vault,
      treasuryTokenAccount: TREASURY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: players[0].ata, isWritable: true, isSigner: false },
    ])
    .rpc();
  console.log("settle_match:", settleSig);

  const winner = await getAccount(connection, players[0].ata);
  const treasury = await getAccount(connection, TREASURY);
  const vaultAcc = await getAccount(connection, vault);
  console.log("winner balance:", Number(winner.amount) / 1e6, "USDC");
  console.log("treasury balance:", Number(treasury.amount) / 1e6, "USDC");
  console.log("vault balance:", Number(vaultAcc.amount) / 1e6, "USDC");

  const matchState = await (program.account as any).matchEscrow.fetch(matchPda);
  console.log("match status:", JSON.stringify(matchState.status));
  const record = await (program.account as any).settlementRecord.fetch(
    settlementPda
  );
  console.log(
    "settlement record: gross",
    record.totalGross.toString(),
    "fee",
    record.totalFee.toString(),
    "net",
    record.totalNet.toString()
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
