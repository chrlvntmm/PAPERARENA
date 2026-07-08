import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { CONFIG, type ArenaType, type WagerAmount } from "./config.js";
import { ClientSession } from "./websocket/ClientSession.js";
import { MatchmakingQueue } from "./lobby/MatchmakingQueue.js";
import { MatchManager } from "./game/MatchManager.js";
import { Match } from "./game/Match.js";
import { requireAuth } from "./auth/session.middleware.js";
import { verifyEscrowBuyIn } from "./auth/escrow.service.js";
import { ClientMessageSchema } from "./types/protocol.js";
import { db } from "./db/postgres.js";
import { handleHttpRequest } from "./http/auth.routes.js";
import { authenticateSessionToken } from "./auth/auth.service.js";
import { getSessionTokenFromCookie } from "./auth/cookies.js";
import { checkRateLimit, cleanupRateLimitBuckets } from "./http/rate-limit.js";

await db.connect();

const httpServer = createServer(async (req, res) => {
  try {
    const handled = await handleHttpRequest(req, res);
    if (!handled) {
      res.writeHead(404).end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "INTERNAL_ERROR", message }));
  }
});

const wss = new WebSocketServer({ server: httpServer });
const queue = new MatchmakingQueue();
const matches = new MatchManager();
const sessions = new Map<string, ClientSession>();

httpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[PaperArena] listening on :${CONFIG.PORT}`);
});

wss.on("connection", async (ws, req) => {
  const rateLimit = checkRateLimit(req, "ws:connect", CONFIG.RATE_LIMIT.WS_CONNECT_MAX);
  if (!rateLimit.ok) {
    ws.close(1008, "Too many connection attempts");
    return;
  }

  const identity = await authenticateSessionToken(getSessionTokenFromCookie(req));
  const session = new ClientSession(ws, identity);
  sessions.set(session.id, session);
  session.send(
    identity
      ? { type: "auth_ok", sessionId: session.id }
      : { type: "auth_fail", reason: "No active session" },
  );

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
          session.walletAddress!,
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

const rateLimitCleanup = setInterval(cleanupRateLimitBuckets, CONFIG.RATE_LIMIT.WINDOW_MS);
rateLimitCleanup.unref();

process.on("SIGTERM", () => {
  clearInterval(rateLimitCleanup);
  wss.close();
  httpServer.close(() => {
    void db.close().finally(() => process.exit(0));
  });
});
