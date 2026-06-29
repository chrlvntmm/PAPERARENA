import type { WebSocket } from "ws";
import { nanoid } from "nanoid";
import type { ServerMessage } from "../types/protocol.js";

export class ClientSession {
  readonly id = nanoid();
  ws: WebSocket;
  authenticated = false;
  publicKey?: string;
  matchId?: string;
  playerId?: number;
  lastInputAt = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
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
