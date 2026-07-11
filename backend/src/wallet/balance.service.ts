import { createPublicClient, formatEther, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { CONFIG } from "../config.js";
import type { WalletDocument } from "../db/postgres.js";

export interface WalletBalancePayload {
  walletId: string;
  chainType: WalletDocument["chainType"];
  chainId: string;
  address: string;
  balance: string;
  symbol: "ETH" | "SOL";
  rawValue: string;
  decimals: number;
}

export async function getWalletBalance(wallet: WalletDocument): Promise<WalletBalancePayload> {
  if (wallet.chainType === "evm") {
    return getEvmBalance(wallet);
  }
  return getSolanaBalance(wallet);
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

async function getSolanaBalance(wallet: WalletDocument): Promise<WalletBalancePayload> {
  const lamports = await fetchSolanaLamports(wallet.address);
  return {
    walletId: wallet.id,
    chainType: wallet.chainType,
    chainId: wallet.chainId,
    address: wallet.address,
    balance: String(lamports / 1_000_000_000),
    symbol: "SOL",
    rawValue: String(lamports),
    decimals: 9,
  };
}

async function fetchSolanaLamports(address: string) {
  const res = await fetch(requireRpcUrl(CONFIG.RPC.SOLANA_URL, "SOLANA_RPC_URL"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "paperarena-balance",
      method: "getBalance",
      params: [address],
    }),
  });
  if (!res.ok) throw new Error("Could not reach Solana RPC.");

  const payload = (await res.json()) as {
    result?: { value?: number };
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? "Solana balance refresh failed.");

  const lamports = payload.result?.value;
  if (typeof lamports !== "number" || !Number.isFinite(lamports)) {
    throw new Error("Solana RPC returned an invalid balance.");
  }
  return lamports;
}

function requireRpcUrl(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required for backend balance lookup.`);
  return value;
}
