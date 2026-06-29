import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { CONFIG, type ArenaType, type WagerAmount } from "./config.js";
import { ClientSession } from "./websocket/ClientSession.js";
import { MatchmakingQueue } from "./lobby/MatchmakingQueue.js";
import { MatchManager } from "./game/MatchManager.js";
import { Match } from "./game/Match.js";
import { verifySolanaAuth, requireAuth } from "./auth/solana.middleware.js";
import { verifyEscrowBuyIn } from "./auth/escrow.service.js";
import { ClientMessageSchema } from "./types/protocol.js";

const httpServer = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer });
const queue = new MatchmakingQueue();
const matches = new MatchManager();
const sessions = new Map<string, ClientSession>();

httpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[PaperArena] listening on :${CONFIG.PORT}`);
});

wss.on("connection", (ws) => {
  const session = new ClientSession(ws);
  sessions.set(session.id, session);

  ws.on("message", async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      session.send({ type: "error", code: "INVALID_JSON", message: "Bad payload" });
      return;
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      session.send({
        type: "error",
        code: "INVALID_MESSAGE",
        message: result.error.message,
      });
      return;
    }

    const msg = result.data;

    switch (msg.type) {
      case "auth": {
        const auth = await verifySolanaAuth(msg);
        if (!auth.ok) {
          session.send({ type: "auth_fail", reason: auth.reason ?? "Auth failed" });
          return;
        }
        session.authenticated = true;
        session.publicKey = auth.publicKey;
        session.send({ type: "auth_ok", sessionId: session.id });
        break;
      }

      case "join_queue": {
        if (!requireAuth(session)) {
          session.send({ type: "error", code: "UNAUTH", message: "Authenticate first" });
          return;
        }
        if (!CONFIG.WAGERS.includes(msg.wager as WagerAmount)) {
          session.send({ type: "error", code: "BAD_WAGER", message: "Invalid wager" });
          return;
        }

        const escrow = await verifyEscrowBuyIn(
          session.publicKey!,
          msg.wager,
          "pending",
        );
        if (!escrow.ok) {
          session.send({
            type: "error",
            code: "NO_ESCROW",
            message: escrow.reason ?? "Escrow required",
          });
          return;
        }

        const locked = queue.join(
          session,
          msg.arena as ArenaType,
          msg.wager as WagerAmount,
          msg.username,
          msg.color,
        );
        if (locked) {
          const match = new Match(locked.arena, locked.wager, locked.players, () => {
            matches.remove(match.id);
          });
          matches.create(match);
        }
        break;
      }

      case "leave_queue":
        queue.leave(session);
        break;

      case "input": {
        if (!session.matchId) return;
        const now = Date.now();
        if (now - session.lastInputAt < 30) return;
        session.lastInputAt = now;
        matches.get(session.matchId)?.handleInput(session, msg.dir);
        break;
      }

      case "ping":
        session.send({ type: "pong", t: msg.t });
        break;
    }
  });

  ws.on("close", () => {
    queue.leave(session);
    if (session.matchId) {
      matches.get(session.matchId)?.handleDisconnect(session);
    }
    sessions.delete(session.id);
  });
});

process.on("SIGTERM", () => {
  wss.close();
  httpServer.close(() => process.exit(0));
});
