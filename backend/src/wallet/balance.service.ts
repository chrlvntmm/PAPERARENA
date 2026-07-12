import { createPublicClient, formatEther, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { CONFIG } from "../config.js";
import type { WalletDocument } from "../db/postgres.js";

export interface WalletBalancePayload {
  walletId: string;
  chainType: WalletDocument["chainType"];
  chainId: string;
  address: string;
  /** Primary display balance for paid play (wager token on Solana when escrow is configured). */
  balance: string;
  symbol: string;
  rawValue: string;
  decimals: number;
  /** What this primary balance represents. */
  balanceKind: "wager_token" | "native";
  tokenMint?: string;
  /** Native SOL for fees only (Solana wallets). */
  gasBalance?: string;
  gasSymbol?: "SOL";
  gasRawValue?: string;
}

export async function getWalletBalance(wallet: WalletDocument): Promise<WalletBalancePayload> {
  if (wallet.chainType === "evm") {
    return getEvmBalance(wallet);
  }
  return getSolanaPlayableBalance(wallet);
}

async function getEvmBalance(wallet: WalletDocument): Promise<WalletBalancePayload> {
  const chain = evmChain(wallet.chainId);
  const client = createPublicClient({
    chain: chain.chain,
    transport: http(chain.rpcUrl),
  });
  const rawValue = await client.getBalance({
    address: wallet.address as `0x${string}`,
  });

  return {
    walletId: wallet.id,
    chainType: wallet.chainType,
    chainId: wallet.chainId,
    address: wallet.address,
    balance: formatEther(rawValue),
    symbol: "ETH",
    rawValue: rawValue.toString(),
    decimals: 18,
    balanceKind: "native",
  };
}

function evmChain(chainId: string) {
  switch (chainId) {
    case "eip155:1":
      return {
        chain: mainnet,
        rpcUrl: requireRpcUrl(CONFIG.RPC.ETHEREUM_MAINNET_URL, "ETH_RPC_URL"),
      };
    case "eip155:11155111":
      return {
        chain: sepolia,
        rpcUrl: requireRpcUrl(CONFIG.RPC.SEPOLIA_URL, "SEPOLIA_RPC_URL"),
      };
    default:
      throw new Error(`Unsupported EVM chain for balance lookup: ${chainId}`);
  }
}

/**
 * Pay-per-match model: primary balance is the escrow wager token (e.g. USDC mint).
 * Native SOL is returned only as gas for transaction fees.
 */
async function getSolanaPlayableBalance(wallet: WalletDocument): Promise<WalletBalancePayload> {
  const rpcUrl = requireRpcUrl(CONFIG.RPC.SOLANA_URL, "active Solana RPC URL");
  const lamports = await fetchSolanaLamports(wallet.address, rpcUrl);
  const gasBalance = formatUnits(BigInt(lamports), 9);

  const mint = CONFIG.ESCROW.TOKEN_MINT;
  if (mint) {
    const decimals = CONFIG.ESCROW.TOKEN_DECIMALS;
    const raw = await fetchSplTokenRawBalance(wallet.address, mint, rpcUrl);
    return {
      walletId: wallet.id,
      chainType: wallet.chainType,
      chainId: wallet.chainId,
      address: wallet.address,
      balance: formatUnits(raw, decimals),
      symbol: CONFIG.ESCROW.TOKEN_SYMBOL,
      rawValue: raw.toString(),
      decimals,
      balanceKind: "wager_token",
      tokenMint: mint,
      gasBalance,
      gasSymbol: "SOL",
      gasRawValue: String(lamports),
    };
  }

  // Escrow mint not configured: fall back to SOL (dev / incomplete config only).
  return {
    walletId: wallet.id,
    chainType: wallet.chainType,
    chainId: wallet.chainId,
    address: wallet.address,
    balance: gasBalance,
    symbol: "SOL",
    rawValue: String(lamports),
    decimals: 9,
    balanceKind: "native",
    gasBalance,
    gasSymbol: "SOL",
    gasRawValue: String(lamports),
  };
}

async function fetchSolanaLamports(address: string, rpcUrl: string) {
  const payload = await solanaRpc<{ value?: number }>(rpcUrl, "getBalance", [address]);
  const lamports = payload.value;
  if (typeof lamports !== "number" || !Number.isFinite(lamports)) {
    throw new Error("Solana RPC returned an invalid SOL balance.");
  }
  return lamports;
}

async function fetchSplTokenRawBalance(owner: string, mint: string, rpcUrl: string): Promise<bigint> {
  const payload = await solanaRpc<{
    value?: Array<{
      account?: {
        data?: {
          parsed?: {
            info?: {
              tokenAmount?: {
                amount?: string;
              };
            };
          };
        };
      };
    }>;
  }>(rpcUrl, "getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed" },
  ]);

  const accounts = payload.value ?? [];
  let total = 0n;
  for (const entry of accounts) {
    const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amount && /^\d+$/.test(amount)) {
      total += BigInt(amount);
    }
  }
  return total;
}

async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `paperarena-${method}`,
      method,
      params,
    }),
  });
  if (!res.ok) throw new Error("Could not reach Solana RPC.");

  const payload = (await res.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? `Solana ${method} failed.`);
  if (payload.result === undefined) throw new Error(`Solana ${method} returned no result.`);
  return payload.result;
}

function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const formatted = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

function requireRpcUrl(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for backend balance lookup.`);
  return value;
}
