const SOLANA_CLUSTER = import.meta.env.VITE_SOLANA_CLUSTER;
const SOLANA_DEVNET_RPC_URL = import.meta.env.VITE_SOLANA_DEVNET_RPC_URL;
const SOLANA_MAINNET_RPC_URL = import.meta.env.VITE_SOLANA_MAINNET_RPC_URL;
const LEGACY_SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL;

if (SOLANA_CLUSTER !== "devnet" && SOLANA_CLUSTER !== "mainnet-beta") {
  throw new Error("VITE_SOLANA_CLUSTER must be devnet or mainnet-beta.");
}

const selectedRpcUrl =
  SOLANA_CLUSTER === "devnet"
    ? SOLANA_DEVNET_RPC_URL ?? LEGACY_SOLANA_RPC_URL
    : SOLANA_MAINNET_RPC_URL ?? LEGACY_SOLANA_RPC_URL;

if (!selectedRpcUrl) {
  throw new Error(`VITE_SOLANA_${SOLANA_CLUSTER === "devnet" ? "DEVNET" : "MAINNET"}_RPC_URL is required for VITE_SOLANA_CLUSTER=${SOLANA_CLUSTER}.`);
}

export const SOLANA_CONFIG = {
  cluster: SOLANA_CLUSTER,
  chainId: `solana:${SOLANA_CLUSTER}`,
  rpcUrl: selectedRpcUrl,
} as const;
