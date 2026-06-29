import type { ClientSession } from "../websocket/ClientSession.js";

export interface AuthResult {
  ok: boolean;
  publicKey?: string;
  reason?: string;
}

/** Placeholder — replace with @solana/web3.js nacl.sign.detached.verify */
export async function verifySolanaAuth(msg: {
  publicKey: string;
  signature: string;
  message: string;
}): Promise<AuthResult> {
  if (!msg.publicKey || !msg.signature) {
    return { ok: false, reason: "Missing credentials" };
  }

  // TODO: Verify ed25519 signature over `message` using publicKey
  // const verified = nacl.sign.detached.verify(
  //   new TextEncoder().encode(msg.message),
  //   bs58.decode(msg.signature),
  //   bs58.decode(msg.publicKey),
  // );

  if (process.env.SOLANA_AUTH_BYPASS === "true") {
    return { ok: true, publicKey: msg.publicKey };
  }

  return { ok: false, reason: "Solana verification not configured" };
}

export function requireAuth(session: ClientSession): boolean {
  return session.authenticated && !!session.publicKey;
}
