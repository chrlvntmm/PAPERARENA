import type { WebSocket } from "ws";
import { nanoid } from "nanoid";
import type { ServerMessage } from "../types/protocol.js";
import type { AuthenticatedIdentity } from "../auth/auth.service.js";

export class ClientSession {
  readonly id = nanoid();
  ws: WebSocket;
  authenticated = false;
  userId?: string;
  walletId?: string;
  walletAddress?: string;
  walletChainType?: string;
  walletChainId?: string;
  matchId?: string;
  playerId?: number;
  lastInputAt = 0;

  constructor(ws: WebSocket, identity?: AuthenticatedIdentity | null) {
    this.ws = ws;
    if (identity) {
      const primaryWallet = identity.wallets[0];
      this.authenticated = true;
      this.userId = identity.user.id;
      this.walletId = primaryWallet?.id;
      this.walletAddress = primaryWallet?.address;
      this.walletChainType = primaryWallet?.chainType;
      this.walletChainId = primaryWallet?.chainId;
    }
  }

  send(msg: ServerMessage | object) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.ws.close();
  }
}
