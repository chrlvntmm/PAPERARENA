import assert from "node:assert/strict";
import test from "node:test";

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

test("stale socket close cannot remove a newer queue entry for the same wallet", async () => {
  const { MatchmakingQueue } = await import("./MatchmakingQueue.js");
  const { ClientSession } = await import("../websocket/ClientSession.js");

  const queue = new MatchmakingQueue();
  const oldSession = makeSession(ClientSession, "wallet-a");
  const newSession = makeSession(ClientSession, "wallet-a");
  const opponent = makeSession(ClientSession, "wallet-b");

  assert.equal(queue.join(oldSession.session, "standard", 10, "OLD", "#ff3366"), null);
  assert.equal(queue.join(newSession.session, "standard", 10, "NEW", "#3afff0"), null);

  assert.equal(oldSession.messages.some((msg) => msg.code === "QUEUE_REPLACED"), true);

  queue.leave(oldSession.session);

  const locked = queue.join(opponent.session, "standard", 10, "OPPONENT", "#f4ff3a");

  assert.ok(locked);
  assert.deepEqual(
    locked.players.map((entry) => entry.session.id),
    [newSession.session.id, opponent.session.id],
  );
});

function makeSession(
  ClientSession: typeof import("../websocket/ClientSession.js").ClientSession,
  walletId: string,
) {
  const messages: SentMessage[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw) as SentMessage),
    close: () => undefined,
  };
  const session = new ClientSession(ws as never, {
    user: { id: `user-${walletId}`, status: "active", createdAt: new Date(), updatedAt: new Date() },
    session: {
      id: `session-${walletId}`,
      userId: `user-${walletId}`,
      sessionTokenHash: "hash",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      lastSeenAt: new Date(),
    },
    wallets: [
      {
        id: walletId,
        userId: `user-${walletId}`,
        chainType: "evm",
        chainId: "1",
        address: `0x${walletId.padEnd(40, "0").slice(0, 40)}`,
        addressNormalized: `0x${walletId.padEnd(40, "0").slice(0, 40)}`,
        firstVerifiedAt: new Date(),
        lastVerifiedAt: new Date(),
        createdAt: new Date(),
      },
    ],
  });

  return { session, messages };
}
