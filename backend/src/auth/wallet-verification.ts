import bs58 from "bs58";
import nacl from "tweetnacl";
import { verifyMessage } from "viem";

export type ChainType = "solana" | "evm";

export interface WalletIdentity {
  chainType: ChainType;
  chainId: string;
  address: string;
  addressNormalized: string;
}

export function normalizeWalletAddress(chainType: ChainType, address: string): string {
  const trimmed = address.trim();
  if (chainType === "evm") return trimmed.toLowerCase();
  return trimmed;
}

export function assertValidWalletAddress(chainType: ChainType, address: string) {
  if (chainType === "solana") {
    const decoded = bs58.decode(address);
    if (decoded.length !== 32) {
      throw new Error("Invalid Solana public key.");
    }
    return;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Invalid EVM address.");
  }
}

export async function verifyWalletSignature(args: {
  chainType: ChainType;
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  if (args.chainType === "solana") {
    try {
      const messageBytes = new TextEncoder().encode(args.message);
      const signatureBytes = bs58.decode(args.signature);
      const publicKeyBytes = bs58.decode(args.address);
      if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) return false;
      return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    } catch {
      return false;
    }
  }

  try {
    return await verifyMessage({
      address: args.address as `0x${string}`,
      message: args.message,
      signature: args.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
