import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const SOL_RATE = 0.014;
const STORAGE_KEY = "paperarena.wallet.balance";
const STARTING_BALANCE = 500;

interface WalletCtx {
  balance: number;
  setBalance: (n: number) => void;
  deduct: (n: number) => boolean;
  credit: (n: number) => void;
}

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [balance, setBalanceState] = useState<number>(STARTING_BALANCE);

  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (raw != null) {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) setBalanceState(n);
      }
    } catch {}
  }, []);

  const setBalance = (n: number) => {
    setBalanceState(n);
    try { window.localStorage.setItem(STORAGE_KEY, String(n)); } catch {}
  };
  const deduct = (n: number) => {
    if (balance < n) return false;
    setBalance(+(balance - n).toFixed(2));
    return true;
  };
  const credit = (n: number) => setBalance(+(balance + n).toFixed(2));

  return <Ctx.Provider value={{ balance, setBalance, deduct, credit }}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}

export function formatUSD(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function formatSOL(usd: number) {
  return `${(usd * SOL_RATE).toFixed(4)} SOL`;
}
