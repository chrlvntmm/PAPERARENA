import bs58 from "bs58";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useChainId, useDisconnect, useSignMessage } from "wagmi";

const API_URL = import.meta.env.VITE_API_URL;
const SOLANA_CHAIN_ID = import.meta.env.VITE_SOLANA_CHAIN_ID;

if (!API_URL) {
  throw new Error("VITE_API_URL is required.");
}

if (!SOLANA_CHAIN_ID) {
  throw new Error("VITE_SOLANA_CHAIN_ID is required.");
}

type ChainType = "solana" | "evm";

interface AuthWallet {
  id: string;
  chainType: ChainType;
  chainId: string;
  address: string;
  verifiedAt: string;
}

interface AuthUser {
  id: string;
  displayName?: string;
  status: string;
  createdAt: string;
}

interface AuthState {
  user: AuthUser | null;
  wallets: AuthWallet[];
  loading: boolean;
  error: string | null;
  balance: number | null;
  connected: boolean;
  primaryWallet: AuthWallet | null;
  signIn: () => Promise<void>;
  signInEvm: () => Promise<void>;
  signInSolana: () => Promise<void>;
  openEvmPicker: () => void;
  openSolanaPicker: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  evmWalletReady: boolean;
  evmAddress: string | null;
  solanaWalletReady: boolean;
  solanaAddress: string | null;
  setBalance: (n: number) => void;
  deduct: (n: number) => boolean;
  credit: (n: number) => void;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, encoding: "utf8"): Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
  }
}

const Ctx = createContext<AuthState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const evmAccount = useAccount();
  const evmChainId = useChainId();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { openConnectModal } = useConnectModal();
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [wallets, setWallets] = useState<AuthWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalanceState] = useState<number | null>(null);

  const primaryWallet = wallets[0] ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api("/auth/me", { method: "GET" });
      if (res.status === 401) {
        setUser(null);
        setWallets([]);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error("Could not load session.");
      const payload = (await res.json()) as { user: AuthUser; wallets: AuthWallet[] };
      setUser(payload.user);
      setWallets(payload.wallets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load session.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, []);

  const signInEvm = useCallback(async () => {
    if (!evmAccount.address) {
      openConnectModal?.();
      throw new Error("Choose an EVM wallet to continue.");
    }
    setError(null);
    const chainId = `eip155:${evmChainId}`;
    const challenge = await createChallenge({
      chainType: "evm",
      chainId,
      address: evmAccount.address,
    });
    const signature = await signMessageAsync({ message: challenge.message });
    await verifySignedChallenge({
      challengeId: challenge.challengeId,
      chainType: "evm",
      chainId,
      address: evmAccount.address,
      signature,
    });
    await refresh();
  }, [evmAccount.address, evmChainId, openConnectModal, refresh, signMessageAsync]);

  const signInSolana = useCallback(async () => {
    const provider = window.solana;
    if (!provider?.isPhantom) throw new Error("Install Phantom to sign in with Solana.");
    setError(null);
    const connected = await provider.connect();
    const address = connected.publicKey.toString();
    setSolanaAddress(address);
    const challenge = await createChallenge({
      chainType: "solana",
      chainId: SOLANA_CHAIN_ID,
      address,
    });
    const encoded = new TextEncoder().encode(challenge.message);
    const signed = await provider.signMessage(encoded, "utf8");
    await verifySignedChallenge({
      challengeId: challenge.challengeId,
      chainType: "solana",
      chainId: SOLANA_CHAIN_ID,
      address,
      signature: bs58.encode(signed.signature),
    });
    await refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    if (solanaAddress) {
      await signInSolana();
      return;
    }
    await signInEvm();
  }, [signInEvm, signInSolana, solanaAddress]);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    if (evmAccount.isConnected) await disconnectAsync();
    await window.solana?.disconnect?.();
    setSolanaAddress(null);
    setUser(null);
    setWallets([]);
    setBalanceState(null);
  }, [disconnectAsync, evmAccount.isConnected]);

  const setBalance = (n: number) => setBalanceState(n);
  const deduct = (n: number) => {
    if (balance == null) return false;
    if (balance < n) return false;
    setBalanceState((current) => +(current - n).toFixed(2));
    return true;
  };
  const credit = (n: number) => setBalanceState((current) => (current == null ? null : +(current + n).toFixed(2)));

  const value = useMemo<AuthState>(
    () => ({
      user,
      wallets,
      loading,
      error,
      balance,
      connected: !!user,
      primaryWallet,
      signIn,
      signInEvm,
      signInSolana,
      openEvmPicker: () => openConnectModal?.(),
      openSolanaPicker: async () => {
        const provider = window.solana;
        if (!provider?.isPhantom) throw new Error("Install Phantom to sign in with Solana.");
        const connected = await provider.connect();
        setSolanaAddress(connected.publicKey.toString());
      },
      signOut,
      refresh,
      evmWalletReady: Boolean(evmAccount.address),
      evmAddress: evmAccount.address ?? null,
      solanaWalletReady: Boolean(solanaAddress),
      solanaAddress,
      setBalance,
      deduct,
      credit,
    }),
    [
      user,
      wallets,
      loading,
      error,
      balance,
      primaryWallet,
      signIn,
      signInEvm,
      signInSolana,
      signOut,
      refresh,
      openConnectModal,
      evmAccount.address,
      solanaAddress,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}

async function createChallenge(input: { chainType: ChainType; chainId: string; address: string }) {
  const res = await api("/auth/challenge", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not create auth challenge.");
  }
  return (await res.json()) as {
    challengeId: string;
    message: string;
    expiresAt: string;
  };
}

async function verifySignedChallenge(input: {
  challengeId: string;
  chainType: ChainType;
  chainId: string;
  address: string;
  signature: string;
}) {
  const verify = await api("/auth/verify", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!verify.ok) {
    const payload = await safeJson(verify);
    throw new Error(payload?.message ?? "Wallet verification failed.");
  }
}

function api(path: string, init: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function safeJson(res: Response): Promise<{ message?: string } | null> {
  try {
    return (await res.json()) as { message?: string };
  } catch {
    return null;
  }
}

export function formatUSD(n: number | null) {
  if (n == null) return "$0.00";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSOL(usd: number | null) {
  if (usd == null) return "0.00 USD";
  return `${usd.toFixed(2)} USD`;
}
