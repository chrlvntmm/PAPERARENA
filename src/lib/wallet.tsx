import bs58 from "bs58";
import { useWallet as useSolanaAdapterWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useConnections, useDisconnect } from "wagmi";
import { SOLANA_CONFIG } from "./solana-config";

const API_URL = import.meta.env.VITE_API_URL;

if (!API_URL) {
  throw new Error("VITE_API_URL is required.");
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
  /** @deprecated Fake client money — always null. Do not use for paid play. */
  balance: number | null;
  /** Wager-token balance available in wallet for pay-per-match deposits. */
  playableBalance: string | null;
  playableBalanceSymbol: string | null;
  playableBalanceKind: "wager_token" | "native" | null;
  tokenMint: string | null;
  /** Native SOL for fees only. */
  gasBalance: string | null;
  gasBalanceSymbol: string | null;
  /** Alias of playableBalance for older UI call sites. */
  nativeBalance: string | null;
  nativeBalanceSymbol: string | null;
  balanceLoading: boolean;
  connected: boolean;
  hasWalletConnection: boolean;
  primaryWallet: AuthWallet | null;
  solanaWallet: AuthWallet | null;
  signIn: () => Promise<void>;
  signInSolana: () => Promise<void>;
  openSolanaPicker: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Full session + balance. Prefer refreshBalance after matches (avoids lobby "loading" flash). */
  refresh: () => Promise<void>;
  /** Playable token balance only — does not flip session loading. */
  refreshBalance: () => Promise<void>;
  /**
   * Efficient post-match balance refresh.
   * One visible read; quiet retries only if a payout is expected and balance hasn't moved yet.
   */
  refreshBalanceAfterMatch: (options?: { expectPayout?: boolean }) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<AuthUser>;
  evmWalletReady: boolean;
  evmAddress: string | null;
  solanaWalletReady: boolean;
  solanaAddress: string | null;
}

const Ctx = createContext<AuthState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const evmAccount = useAccount();
  const evmConnections = useConnections();
  const { disconnectAsync } = useDisconnect();
  const solanaAdapter = useSolanaAdapterWallet();
  const { setVisible: setSolanaWalletModalVisible } = useWalletModal();
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [wallets, setWallets] = useState<AuthWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playableBalance, setPlayableBalance] = useState<string | null>(null);
  const [playableBalanceSymbol, setPlayableBalanceSymbol] = useState<string | null>(null);
  const [playableBalanceKind, setPlayableBalanceKind] = useState<"wager_token" | "native" | null>(null);
  const [tokenMint, setTokenMint] = useState<string | null>(null);
  const [gasBalance, setGasBalance] = useState<string | null>(null);
  const [gasBalanceSymbol, setGasBalanceSymbol] = useState<string | null>(null);
  const [nativeBalanceLoading, setNativeBalanceLoading] = useState(false);

  const solanaWallet = selectSolanaWallet(wallets);
  const primaryWallet = solanaWallet ?? wallets[0] ?? null;
  const hasWalletConnection =
    Boolean(user) ||
    evmAccount.isConnected ||
    evmConnections.length > 0 ||
    solanaAdapter.connected ||
    Boolean(solanaAdapter.publicKey);

  const clearBalances = useCallback(() => {
    setPlayableBalance(null);
    setPlayableBalanceSymbol(null);
    setPlayableBalanceKind(null);
    setTokenMint(null);
    setGasBalance(null);
    setGasBalanceSymbol(null);
  }, []);

  const refreshNativeBalance = useCallback(
    async (
      wallet: AuthWallet | null = solanaWallet,
      options: { quiet?: boolean } = {},
    ): Promise<string | null> => {
      if (!wallet || wallet.chainType !== "solana") {
        clearBalances();
        return null;
      }

      if (!options.quiet) setNativeBalanceLoading(true);
      try {
        const res = await api(`/wallet/balance?walletId=${encodeURIComponent(wallet.id)}`, {
          method: "GET",
        });
        if (!res.ok) {
          const payload = await safeJson(res);
          throw new Error(payload?.message ?? "Could not refresh wallet balance.");
        }
        const payload = (await res.json()) as {
          balance: string;
          symbol: string;
          balanceKind?: "wager_token" | "native";
          tokenMint?: string;
          gasBalance?: string;
          gasSymbol?: string;
        };
        const next = trimBalance(payload.balance);
        setPlayableBalance(next);
        setPlayableBalanceSymbol(payload.symbol ?? "USDC");
        setPlayableBalanceKind(payload.balanceKind ?? "wager_token");
        setTokenMint(payload.tokenMint ?? null);
        setGasBalance(payload.gasBalance ? trimBalance(payload.gasBalance) : null);
        setGasBalanceSymbol(payload.gasSymbol ?? "SOL");
        setError(null);
        return next;
      } catch (err) {
        // Keep last known balance on transient RPC errors (esp. post-match polls).
        setError(err instanceof Error ? err.message : "Could not refresh wallet balance.");
        return null;
      } finally {
        if (!options.quiet) setNativeBalanceLoading(false);
      }
    },
    [clearBalances, solanaWallet],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api("/auth/me", { method: "GET" });
      if (res.status === 401) {
        setUser(null);
        setWallets([]);
        clearBalances();
        setError(null);
        return;
      }
      if (!res.ok) throw new Error("Could not load session.");
      const payload = (await res.json()) as { user: AuthUser; wallets: AuthWallet[] };
      setUser(payload.user);
      setWallets(payload.wallets);
      setError(null);
      await refreshNativeBalance(selectSolanaWallet(payload.wallets));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load session.");
    } finally {
      setLoading(false);
    }
  }, [clearBalances, refreshNativeBalance]);

  const refreshBalance = useCallback(async () => {
    await refreshNativeBalance();
  }, [refreshNativeBalance]);

  /**
   * One visible refresh. Quiet retries only when a payout is expected and balance
   * hasn't changed yet — stop as soon as it updates (or after 2 quiet tries).
   */
  const refreshBalanceAfterMatch = useCallback(
    async (options: { expectPayout?: boolean } = {}) => {
      const before = playableBalance;
      const first = await refreshNativeBalance(solanaWallet, { quiet: false });
      // Balance already moved, or no payout expected (loss / no settle lag) — done.
      if (!options.expectPayout) return;
      if (first != null && first !== before) return;

      await new Promise((r) => setTimeout(r, 2_500));
      const second = await refreshNativeBalance(solanaWallet, { quiet: true });
      if (second != null && second !== before) return;

      await new Promise((r) => setTimeout(r, 4_000));
      await refreshNativeBalance(solanaWallet, { quiet: true });
    },
    [playableBalance, refreshNativeBalance, solanaWallet],
  );

  useEffect(() => {
    void refresh();
  }, []);

  const verifySolanaWallet = useCallback(async () => {
    if (!solanaAdapter.publicKey || !solanaAdapter.signMessage) {
      throw new Error("Choose a Solana wallet to continue.");
    }
    setError(null);
    const address = solanaAdapter.publicKey.toString();
    setSolanaAddress(address);
    const challenge = await createChallenge({
      chainType: "solana",
      chainId: SOLANA_CONFIG.chainId,
      address,
    });
    const encoded = new TextEncoder().encode(challenge.message);
    await waitForWalletUi();
    const signature = await solanaAdapter.signMessage(encoded);
    await verifySignedChallenge({
      challengeId: challenge.challengeId,
      chainType: "solana",
      chainId: SOLANA_CONFIG.chainId,
      address,
      signature: bs58.encode(signature),
    });
    await refresh();
  }, [refresh, solanaAdapter.publicKey, solanaAdapter.signMessage]);

  const signInSolana = useCallback(async () => {
    if (!solanaAdapter.publicKey || !solanaAdapter.signMessage) {
      setSolanaWalletModalVisible(true);
      return;
    }
    await verifySolanaWallet();
  }, [setSolanaWalletModalVisible, solanaAdapter.publicKey, solanaAdapter.signMessage, verifySolanaWallet]);

  const signIn = useCallback(async () => {
    await signInSolana();
  }, [signInSolana]);

  const signOut = useCallback(async () => {
    setError(null);
    setSolanaWalletModalVisible(false);

    const evmDisconnects = evmConnections.length > 0
      ? evmConnections.map((connection) => disconnectAsync({ connector: connection.connector }))
      : evmAccount.isConnected
        ? [disconnectAsync()]
        : [];

    const disconnectResults = await Promise.allSettled([
      api("/auth/logout", { method: "POST" }),
      ...evmDisconnects,
      solanaAdapter.connected ? solanaAdapter.disconnect() : Promise.resolve(),
    ]);
    clearWalletConnectorStorage();

    setSolanaAddress(null);
    setUser(null);
    setWallets([]);
    clearBalances();

    const failed = disconnectResults.some((result) => result.status === "rejected");
    if (failed) {
      setError("Wallet disconnected locally. Refresh once if your wallet extension still shows an active session.");
    }
  }, [
    clearBalances,
    disconnectAsync,
    evmAccount.isConnected,
    evmConnections,
    setSolanaWalletModalVisible,
    solanaAdapter,
  ]);

  const updateDisplayName = useCallback(async (displayName: string) => {
    const res = await api("/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) {
      const payload = await safeJson(res);
      throw new Error(payload?.message ?? "Could not save username.");
    }
    const payload = (await res.json()) as { user: AuthUser };
    setUser(payload.user);
    return payload.user;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      wallets,
      loading,
      error,
      balance: null,
      playableBalance,
      playableBalanceSymbol,
      playableBalanceKind,
      tokenMint,
      gasBalance,
      gasBalanceSymbol,
      nativeBalance: playableBalance,
      nativeBalanceSymbol: playableBalanceSymbol,
      balanceLoading: nativeBalanceLoading,
      connected: !!user,
      hasWalletConnection,
      primaryWallet,
      solanaWallet,
      signIn,
      signInSolana,
      openSolanaPicker: async () => {
        setSolanaWalletModalVisible(true);
      },
      signOut,
      refresh,
      refreshBalance,
      refreshBalanceAfterMatch,
      updateDisplayName,
      evmWalletReady: Boolean(evmAccount.address),
      evmAddress: evmAccount.address ?? null,
      solanaWalletReady: Boolean(solanaAdapter.publicKey),
      solanaAddress: solanaAdapter.publicKey?.toString() ?? solanaAddress,
    }),
    [
      user,
      wallets,
      loading,
      error,
      playableBalance,
      playableBalanceSymbol,
      playableBalanceKind,
      tokenMint,
      gasBalance,
      gasBalanceSymbol,
      nativeBalanceLoading,
      hasWalletConnection,
      primaryWallet,
      solanaWallet,
      signIn,
      signInSolana,
      signOut,
      refresh,
      refreshBalance,
      refreshBalanceAfterMatch,
      updateDisplayName,
      setSolanaWalletModalVisible,
      evmAccount.address,
      solanaAdapter.publicKey,
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

export function formatNativeBalance(amount: string | null, symbol: string | null) {
  if (amount == null || amount === "") return `0 ${symbol ?? "USDC"}`;
  return `${amount} ${symbol ?? "USDC"}`;
}

/** Primary lobby number: wager-token balance available for match buy-ins. */
export function formatPlayableBalance(amount: string | null, symbol: string | null) {
  return formatNativeBalance(amount, symbol);
}

function clearWalletConnectorStorage() {
  if (typeof window === "undefined") return;
  const prefixes = [
    "wagmi",
    "rk-",
    "rainbowkit",
    "wc@2:",
    "walletconnect",
    "reown",
    "@appkit",
    "solana-wallet",
  ];

  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (!key) continue;
      const normalized = key.toLowerCase();
      if (prefixes.some((prefix) => normalized.startsWith(prefix) || normalized.includes(prefix))) {
        storage.removeItem(key);
      }
    }
  }
}

function selectSolanaWallet(wallets: AuthWallet[]) {
  return wallets.find((wallet) => wallet.chainType === "solana") ?? null;
}

function waitForWalletUi() {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise<void>((resolve) => window.setTimeout(resolve, 250));
}

function trimBalance(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return "0.0000";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}
