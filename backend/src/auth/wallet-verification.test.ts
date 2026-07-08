import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assertValidWalletAddress,
  normalizeWalletAddress,
  verifyWalletSignature,
} from "./wallet-verification.js";

test("verifies a valid EVM personal-sign message", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = "PaperArena auth challenge";
  const signature = await account.signMessage({ message });

  const verified = await verifyWalletSignature({
    chainType: "evm",
    address: account.address,
    message,
    signature,
  });

  assert.equal(verified, true);
});

test("rejects an EVM signature for a different message", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: "original challenge" });

  const verified = await verifyWalletSignature({
    chainType: "evm",
    address: account.address,
    message: "tampered challenge",
    signature,
  });

  assert.equal(verified, false);
});

test("verifies a valid Solana detached signature", async () => {
  const keypair = nacl.sign.keyPair();
  const message = "PaperArena Solana auth challenge";
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

  const verified = await verifyWalletSignature({
    chainType: "solana",
    address: bs58.encode(keypair.publicKey),
    message,
    signature: bs58.encode(signature),
  });

  assert.equal(verified, true);
});

test("normalizes EVM addresses but preserves Solana addresses", () => {
  assert.equal(
    normalizeWalletAddress("evm", "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48"),
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  );
  assert.equal(
    normalizeWalletAddress("solana", "11111111111111111111111111111111"),
    "11111111111111111111111111111111",
  );
});

test("rejects malformed wallet addresses", () => {
  assert.throws(() => assertValidWalletAddress("evm", "not-an-address"), /Invalid EVM address/);
  assert.throws(() => assertValidWalletAddress("solana", "bad"), /Invalid Solana public key/);
});
