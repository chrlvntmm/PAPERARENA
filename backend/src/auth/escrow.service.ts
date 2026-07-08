/** Confirm wager is locked in a real escrow before match lock. */
export async function verifyEscrowBuyIn(
  publicKey: string,
  wagerUsd: number,
  matchId: string,
): Promise<{ ok: boolean; txSignature?: string; reason?: string }> {
  void publicKey;
  void wagerUsd;
  void matchId;

  if (process.env.ESCROW_BYPASS === "true") {
    return { ok: true, txSignature: "dev-bypass" };
  }
  return { ok: false, reason: "Escrow verification is not configured." };
}

export async function settlePayout(
  publicKey: string,
  netPayout: number,
  matchId: string,
): Promise<{ ok: boolean; txSignature?: string }> {
  void publicKey;
  void netPayout;
  void matchId;

  return { ok: false };
}
