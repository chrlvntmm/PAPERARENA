const API_URL = import.meta.env.VITE_API_URL;

if (!API_URL) {
  throw new Error("VITE_API_URL is required.");
}

export type DepositIntentStatus =
  | "created"
  | "awaiting_payment"
  | "submitted"
  | "verified"
  | "expired"
  | "consumed"
  | "failed"
  | "refunded"
  | "forfeited";

export interface DepositBuildParams {
  programId: string;
  configPda: string;
  vaultPda: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountBaseUnits: string;
  onChainIntentId: string;
  depositPda: string;
  playerTokenAccount: string;
  arena: "standard" | "mega";
  wagerTierUsd: number;
  expiresAtUnix: number;
  cluster: string;
}

export interface DepositIntent {
  id: string;
  arena: "standard" | "mega";
  wagerUsd: string;
  status: DepositIntentStatus;
  contractStatus: "not_configured" | "configured";
  tokenSymbol?: string;
  tokenMint?: string;
  amountBaseUnits?: string;
  onChainIntentId?: string;
  txSignature?: string;
  verificationError?: string;
  expiresAt: string;
  verifiedAt?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
  build?: DepositBuildParams;
}

export async function createDepositIntent(input: {
  arena: "standard" | "mega";
  wager: number;
  walletId?: string;
}) {
  const res = await api("/wallet/deposit-intent", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not create deposit request.");
  }
  return (await res.json()) as DepositIntent;
}

export async function getDepositStatus(input: {
  depositIntentId: string;
  walletId?: string;
}) {
  const params = new URLSearchParams({ depositIntentId: input.depositIntentId });
  if (input.walletId) params.set("walletId", input.walletId);
  const res = await api(`/wallet/deposit-status?${params.toString()}`, { method: "GET" });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not refresh deposit status.");
  }
  return (await res.json()) as DepositIntent;
}

export async function confirmDeposit(input: {
  depositIntentId: string;
  txSignature: string;
  walletId?: string;
}) {
  const res = await api("/wallet/deposit-confirm", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not confirm deposit.");
  }
  return (await res.json()) as DepositIntent;
}

export async function listOpenDeposits(input: { walletId?: string } = {}) {
  const params = new URLSearchParams();
  if (input.walletId) params.set("walletId", input.walletId);
  const q = params.toString();
  const res = await api(`/wallet/open-deposits${q ? `?${q}` : ""}`, { method: "GET" });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not load open deposits.");
  }
  const body = (await res.json()) as { deposits: DepositIntent[] };
  return body.deposits;
}

export async function refundDeposit(input: {
  depositIntentId: string;
  walletId?: string;
}) {
  const res = await api("/wallet/deposit-refund", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = await safeJson(res);
    throw new Error(payload?.message ?? "Could not refund deposit.");
  }
  return (await res.json()) as DepositIntent & {
    refundTxSignature?: string;
    alreadyRefunded?: boolean;
  };
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
