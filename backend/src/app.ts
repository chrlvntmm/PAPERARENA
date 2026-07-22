import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { CONFIG, type ArenaType, type WagerAmount } from "./config.js";
import { authenticateSessionToken, type AuthenticatedIdentity } from "./auth/auth.service.js";
import { getSessionTokenFromCookie } from "./auth/cookies.js";
import { lockMatchFunds, reconcileMatchLock, verifyEscrowBuyIn } from "./auth/escrow.service.js";
import { Match } from "./game/Match.js";
import { MatchManager } from "./game/MatchManager.js";
import { handleHttpRequest } from "./http/auth.routes.js";
import { handleOpsRequest } from "./http/ops.routes.js";
import { checkRateLimit, cleanupRateLimitBuckets } from "./http/rate-limit.js";
import { MatchmakingQueue } from "./lobby/MatchmakingQueue.js";
import { ClientMessageSchema } from "./types/protocol.js";
import { ClientSession } from "./websocket/ClientSession.js";

export interface PaperArenaServerOptions {
  authenticate?: (req: IncomingMessage) => Promise<AuthenticatedIdentity | null>;
  verifyEscrow?: (
    walletAddress: string,
    wagerUsd: number,
    matchId: string,
  ) => Promise<{ ok: boolean; txSignature?: string; reason?: string }>;
}

export function createPaperArenaServer(options: PaperArenaServerOptions = {}) {
  const authenticate =
    options.authenticate ??
    ((req: IncomingMessage) => authenticateSessionToken(getSessionTokenFromCookie(req)));
  const verifyEscrow = options.verifyEscrow ?? verifyEscrowBuyIn;

  let draining = false;

  const httpServer = createServer(async (req, res) => {
    try {
      if (await handleOpsRequest(req, res)) return;
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

  wss.on("connection", async (ws, req) => {
    const rateLimit = checkRateLimit(req, "ws:connect", CONFIG.RATE_LIMIT.WS_CONNECT_MAX);
    if (!rateLimit.ok) {
      ws.close(1008, "Too many connection attempts");
      return;
    }

    const identity = await authenticate(req);
    const session = new ClientSession(ws, identity);
    sessions.set(session.id, session);
    session.send(
      identity
        ? { type: "auth_ok", sessionId: session.id }
        : { type: "auth_fail", reason: "No active session" },
    );

    // Resume mid-match if this wallet is still within disconnect grace.
    if (session.authenticated) {
      const resumeKey = session.walletId ?? session.walletAddress ?? session.userId;
      const active = matches.findByIdentity(resumeKey);
      if (active?.tryReconnect(session)) {
        // quiet in normal play
      }
    }

    ws.on("message", async (raw) => {
      try {
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
            if (!session.authenticated) {
              session.send({ type: "error", code: "UNAUTH", message: "Authenticate first" });
              return;
            }
            if (draining) {
              session.send({
                type: "error",
                code: "SERVER_DRAINING",
                message: "Server is restarting. New matches are paused — try again shortly.",
              });
              return;
            }
            if (session.matchId) {
              session.send({
                type: "error",
                code: "IN_MATCH",
                message: "Already in a match. Wait for it to finish.",
              });
              return;
            }
            const resumeKey = session.walletId ?? session.walletAddress ?? session.userId;
            if (matches.findByIdentity(resumeKey)) {
              const resumed = matches.findByIdentity(resumeKey)?.tryReconnect(session);
              if (resumed) return;
            }
            if (!CONFIG.WAGERS.includes(msg.wager as WagerAmount)) {
              session.send({ type: "error", code: "BAD_WAGER", message: "Invalid wager" });
              return;
            }

            if (
              !CONFIG.ESCROW.BYPASS &&
              session.walletChainType &&
              session.walletChainType !== "solana"
            ) {
              session.send({
                type: "error",
                code: "NO_ESCROW",
                message: "Paid matches require a Solana wallet session.",
              });
              return;
            }

            const escrow = await verifyEscrow(session.walletAddress!, msg.wager, "pending", {
              userId: session.userId,
              walletId: session.walletId,
              arena: msg.arena as ArenaType,
              depositIntentId: msg.depositIntentId,
            });
            if (!escrow.ok) {
              session.send({
                type: "error",
                code: "NO_ESCROW",
                message: escrow.reason ?? "Escrow required",
              });
              return;
            }

            session.depositIntentId = msg.depositIntentId;

            const locked = queue.join(
              session,
              msg.arena as ArenaType,
              msg.wager as WagerAmount,
              msg.username,
              msg.color,
              msg.depositIntentId,
            );
            if (locked) {
              // Tell clients immediately so UI is not stuck while on-chain lock runs.
              for (const entry of locked.players) {
                entry.session.send({
                  type: "match_preparing",
                  arena: locked.arena,
                  wager: locked.wager,
                });
              }

              const match = new Match(locked.arena, locked.wager, locked.players, () => {
                matches.remove(match.id);
              });
              // Identities registered when matches.create runs.

              let fundLock = await lockMatchFunds({
                matchId: match.id,
                arena: locked.arena,
                wager: locked.wager,
                players: locked.players.map((entry) => ({
                  walletAddress: entry.session.walletAddress ?? "",
                  walletId: entry.session.walletId,
                  depositIntentId: entry.depositIntentId ?? entry.session.depositIntentId,
                })),
              });

              // Short pending poll only — recovery worker continues if still unknown.
              if (!fundLock.ok && fundLock.pending) {
                for (let i = 0; i < 6; i++) {
                  await new Promise((r) => setTimeout(r, 750));
                  fundLock = await reconcileMatchLock(match.id);
                  if (fundLock.ok || !fundLock.pending) break;
                }
              }

              if (!fundLock.ok) {
                for (const entry of locked.players) {
                  entry.session.matchId = undefined;
                  entry.session.playerId = undefined;
                  entry.session.send({
                    type: "error",
                    code: fundLock.pending ? "LOCK_PENDING" : "LOCK_FAILED",
                    message:
                      fundLock.reason ??
                      (fundLock.pending
                        ? "Match lock is still confirming. Funds stay reserved — try again shortly."
                        : "Could not lock match funds on-chain."),
                  });
                }
                match.destroy();
                break;
              }

              match.setOnChainMatchId(fundLock.onChainMatchIdHex);
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
      } catch {
        session.send({
          type: "error",
          code: "SERVER_ERROR",
          message: "Arena server could not process that request. Please try again.",
        });
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

  function setDraining(value: boolean) {
    draining = value;
  }

  /**
   * Production shutdown only:
   * 1) stop new queues
   * 2) force-end live matches (territory settle)
   * 3) brief wait for async settlement to submit
   * 4) close sockets
   */
  async function drainAndClose(options: { settleWaitMs?: number } = {}) {
    const settleWaitMs = options.settleWaitMs ?? CONFIG.SHUTDOWN_DRAIN_MS;
    setDraining(true);
    const active = matches.activeCount();
    if (active > 0) {
      console.info(`[server] drain: ending ${active} live match(es)`);
    }
    matches.forceEndAll();
    if (active > 0 && settleWaitMs > 0) {
      await new Promise((r) => setTimeout(r, settleWaitMs));
    }
    await close();
  }

  async function close() {
    clearInterval(rateLimitCleanup);
    matches.destroyAll();
    for (const session of sessions.values()) {
      session.close();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return {
    httpServer,
    wss,
    matches,
    setDraining,
    drainAndClose,
    close,
  };
}
