import type { ClientSession } from "../websocket/ClientSession.js";

export function requireAuth(session: ClientSession): boolean {
  return session.authenticated && !!session.userId && !!session.walletAddress;
}
