/** Placeholder — confirm wager locked in on-chain escrow before match lock */
export async function verifyEscrowBuyIn(
  publicKey: string,
  wagerUsd: number,
  matchId: string,
): Promise<{ ok: boolean; txSignature?: string; reason?: string }> {
  void publicKey;
  void wagerUsd;
  void matchId;

  // TODO: Query Solana program account for escrow PDA
  // TODO: Confirm lamports >= wager, status === 'locked', matchId matches

  if (process.env.ESCROW_BYPASS === "true") {
    return { ok: true, txSignature: "dev-bypass" };
  }
  return { ok: false, reason: "Escrow program not deployed" };
}

export async function settlePayout(
  publicKey: string,
  netPayout: number,
  matchId: string,
): Promise<{ ok: boolean; txSignature?: string }> {
  void publicKey;
  void netPayout;
  void matchId;

  // TODO: Release escrow to winner minus platform fee
  return { ok: true, txSignature: "dev-settlement" };
}
