import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { Dir } from "./engine.js";
import type { AuthenticatedIdentity } from "../auth/auth.service.js";
import type { QueueEntry } from "../lobby/MatchmakingQueue.js";
import { ClientSession } from "../websocket/ClientSession.js";

process.env.NODE_ENV = "test";
process.env.PORT = "3333";
process.env.DATABASE_URL = "postgres://paperarena:test@localhost:5432/paperarena_test";
process.env.DATABASE_SSL = "false";
process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = "false";
process.env.DATABASE_POOL_MAX = "2";
process.env.DATABASE_CONNECTION_TIMEOUT_MS = "1000";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_AUTH_CHALLENGE_MAX = "10";
process.env.RATE_LIMIT_AUTH_VERIFY_MAX = "10";
process.env.RATE_LIMIT_WS_CONNECT_MAX = "10";
process.env.AUTH_APP_NAME = "PaperArena";
process.env.AUTH_COOKIE_NAME = "paperarena_session";
process.env.AUTH_SESSION_SECRET = "test-session-secret-that-is-long-enough";
process.env.AUTH_ALLOWED_ORIGINS = "http://localhost:3000";
process.env.AUTH_EXPECTED_DOMAIN = "localhost";
process.env.AUTH_EXPECTED_URI = "http://localhost:3000";
process.env.AUTH_SESSION_TTL_SECONDS = "3600";
process.env.AUTH_CHALLENGE_TTL_SECONDS = "300";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.AUTH_COOKIE_SAME_SITE = "lax";
process.env.ETH_RPC_URL = "https://example.com/eth";
process.env.SEPOLIA_RPC_URL = "https://example.com/sepolia";
process.env.SOLANA_RPC_URL = "https://example.com/solana";
process.env.LOGIC_TICK_MS = "50";
process.env.MOVEMENT_TICKS_PER_STEP = "1";
process.env.BROADCAST_HZ = "20";
process.env.PRE_MATCH_COUNTDOWN_MS = "100";
process.env.DISCONNECT_GRACE_MS = "0";
process.env.PLATFORM_FEE = "0.02";
process.env.STANDARD_ARENA_PLAYERS = "2";
process.env.STANDARD_ARENA_DURATION_MS = "150";
process.env.STANDARD_ARENA_COLS = "40";
process.env.MEGA_ARENA_PLAYERS = "10";
process.env.MEGA_ARENA_DURATION_MS = "300000";
process.env.MEGA_ARENA_COLS = "96";
process.env.WAGER_TIERS = "5,10,20";

type SentMessage = { type: string; [key: string]: unknown };
type FrameableMatch = {
  frame(dtMs: number): void;
  runLogicTick(): void;
};

test("match gates inputs until countdown, starts every player, then advances from server input", async () => {
  const { Match } = await import("./Match.js");
  const sessions = [makeSession(), makeSession()];
  const match = new Match("standard", 10, makeEntries(sessions));
  const player = match.state.players[0];
  const start = { x: player.x, y: player.y };

  match.handleInput(sessions[0], turn(player.dir));
  frame(match, 99);

  assert.deepEqual({ x: player.x, y: player.y }, start);
  assert.equal(messages(sessions[0]).some((msg) => msg.type === "match_start"), false);

  frame(match, 1);

  for (const session of sessions) {
    const starts = messages(session).filter((msg) => msg.type === "match_start");
    assert.equal(starts.length, 1);
    assert.equal(typeof starts[0].matchId, "string");
  }

  match.handleInput(sessions[0], turn(player.dir));
  frame(match, 50);

  assert.notDeepEqual({ x: player.x, y: player.y }, start);
  assert.equal(match.state.elapsed, 1);
  assert.ok(messages(sessions[0]).some((msg) => msg.type === "state"));

  match.destroy();
});

test("match ends by backend timer and sends per-player payout payloads", async () => {
  const { Match } = await import("./Match.js");
  const sessions = [makeSession(), makeSession()];
  const match = new Match("standard", 10, makeEntries(sessions));

  match.state.territory.fill(-1);
  match.state.territory[1 * match.state.cols + 1] = 0;
  match.state.territory[1 * match.state.cols + 2] = 0;
  match.state.territory[2 * match.state.cols + 1] = 1;

  frame(match, 100);
  frame(match, 150);

  assert.equal(match.state.endedByTime, true);
  assert.equal(match.state.winnerId, 0);

  for (const session of sessions) {
    const end = messages(session).find((msg) => msg.type === "match_end");
    assert.ok(end);
    const payload = end.payload as { winnerId: number; platformFee: number; netPayout: number; reason: string };
    assert.equal(payload.reason, "timer");
    assert.equal(payload.winnerId, 0);
    assert.ok(payload.platformFee >= 0);
    assert.ok(payload.netPayout >= 0);
  }
});

test("disconnect grace force-eliminates through canonical cleanup and ends last-standing match", async () => {
  const { Match } = await import("./Match.js");
  const sessions = [makeSession(), makeSession()];
  const match = new Match("standard", 10, makeEntries(sessions));

  frame(match, 100);
  match.handleDisconnect(sessions[0]);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(match.state.players[0].alive, false);
  assert.equal(match.state.players[0].visible, false);
  assert.equal(match.state.players[0].x, -1);
  assert.ok(messages(sessions[0]).some((msg) => msg.type === "eliminated"));
  assert.ok(messages(sessions[1]).some((msg) => msg.type === "match_end"));
});

function frame(match: object, dtMs: number) {
  (match as FrameableMatch).frame(dtMs);
}

function makeEntries(sessions: ClientSession[]): QueueEntry[] {
  return sessions.map((session, i) => ({
    session,
    username: `Player${i + 1}`,
    color: i === 0 ? "#ff0000" : "#00ff00",
    joinedAt: i,
    identityKey: session.walletId ?? session.id,
  }));
}

function makeSession() {
  const sent: string[] = [];
  const now = new Date();
  const userId = `user-${Math.random()}`;
  const walletAddress = `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`;
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
    close: () => undefined,
  } as unknown as WebSocket & { sent: string[] };
  ws.sent = sent;
  const identity: AuthenticatedIdentity = {
    user: {
      id: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `session-${Math.random()}`,
      userId,
      sessionTokenHash: "test-token-hash",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      lastSeenAt: now,
    },
    wallets: [
      {
        id: `wallet-${Math.random()}`,
        userId,
        chainType: "evm",
        chainId: "eip155:1",
        address: walletAddress,
        addressNormalized: walletAddress.toLowerCase(),
        firstVerifiedAt: now,
        lastVerifiedAt: now,
        createdAt: now,
      },
    ],
  };
  const session = new ClientSession(ws, identity);
  return session;
}

function messages(session: ClientSession): SentMessage[] {
  return ((session.ws as WebSocket & { sent: string[] }).sent ?? []).map((payload) =>
    JSON.parse(payload) as SentMessage,
  );
}

function opposite(dir: Dir): Dir {
  switch (dir) {
    case "up":
      return "down";
    case "down":
      return "up";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

function turn(dir: Dir): Dir {
  const candidate = dir === "up" || dir === "down" ? "right" : "up";
  return candidate === opposite(dir) ? "left" : candidate;
}
