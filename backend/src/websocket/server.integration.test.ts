import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import type { AuthenticatedIdentity } from "../auth/auth.service.js";
import type { ServerMessage } from "../types/protocol.js";

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
process.env.RATE_LIMIT_WS_CONNECT_MAX = "20";
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
process.env.PRE_MATCH_COUNTDOWN_MS = "50";
process.env.DISCONNECT_GRACE_MS = "0";
process.env.PLATFORM_FEE = "0.02";
process.env.STANDARD_ARENA_PLAYERS = "2";
process.env.STANDARD_ARENA_DURATION_MS = "1000";
process.env.STANDARD_ARENA_COLS = "40";
process.env.MEGA_ARENA_PLAYERS = "10";
process.env.MEGA_ARENA_DURATION_MS = "300000";
process.env.MEGA_ARENA_COLS = "96";
process.env.WAGER_TIERS = "5,10,20";

test("real WebSocket clients authenticate, join queue, start match, and receive state", async () => {
  const { createPaperArenaServer } = await import("../app.js");
  const app = createPaperArenaServer({
    authenticate: async () => makeIdentity(),
    verifyEscrow: async () => ({ ok: true, txSignature: "test-escrow" }),
  });

  await listen(app.httpServer);
  const address = app.httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;
  const clients: TestSocket[] = [];

  try {
    clients.push(await connect(url));
    clients.push(await connect(url));

    await Promise.all(clients.map((client) => client.waitFor((msg) => msg.type === "auth_ok")));

    clients[0].send({ type: "ping", t: 123 });
    const pong = await clients[0].waitFor<PongMessage>((msg): msg is PongMessage => msg.type === "pong");
    assert.equal(pong.t, 123);

    clients[0].send({
      type: "join_queue",
      arena: "standard",
      wager: 10,
      username: "PLAYER_01",
      color: "#ff3366",
    });
    clients[1].send({
      type: "join_queue",
      arena: "standard",
      wager: 10,
      username: "PLAYER_01",
      color: "#33ccff",
    });

    const starts = await Promise.all(
      clients.map((client) =>
        client.waitFor<MatchStartMessage>((msg): msg is MatchStartMessage => msg.type === "match_start"),
      ),
    );
    assert.equal(new Set(starts.map((msg) => msg.matchId)).size, 1);
    assert.deepEqual(
      starts.map((msg) => msg.playerId).sort(),
      [0, 1],
    );
    assert.deepEqual(
      starts[0].snapshot.players.map((player) => player.name),
      ["PLAYER_01", "PLAYER_01_2"],
    );

    clients[0].send({ type: "input", dir: "down", seq: 1 });
    clients[1].send({ type: "input", dir: "up", seq: 1 });

    const states = await Promise.all(
      clients.map((client) => client.waitFor<StateMessage>((msg): msg is StateMessage => msg.type === "state")),
    );
    for (const state of states) {
      assert.equal(typeof state.tick, "number");
      assert.equal(state.snapshot.players.length, 2);
      assert.equal(state.snapshot.wager, 10);
    }
  } finally {
    for (const client of clients) client.close();
    await app.close();
  }
});

interface TestSocket {
  send(payload: object): void;
  waitFor<TMessage extends ServerMessage>(
    predicate: (msg: ServerMessage) => msg is TMessage,
  ): Promise<TMessage>;
  close(): void;
}

type MatchStartMessage = Extract<ServerMessage, { type: "match_start" }>;
type PongMessage = Extract<ServerMessage, { type: "pong" }>;
type StateMessage = Extract<ServerMessage, { type: "state" }>;

function makeIdentity(): AuthenticatedIdentity {
  const now = new Date();
  const userId = randomUUID();
  return {
    user: {
      id: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: randomUUID(),
      userId,
      sessionTokenHash: "test-session-hash",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      lastSeenAt: now,
    },
    wallets: [
      {
        id: randomUUID(),
        userId,
        chainType: "evm",
        chainId: "eip155:11155111",
        address: `0x${"1".repeat(40)}`,
        addressNormalized: `0x${"1".repeat(40)}`,
        firstVerifiedAt: now,
        lastVerifiedAt: now,
        createdAt: now,
      },
    ],
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function connect(url: string): Promise<TestSocket> {
  const ws = new WebSocket(url, {
    headers: {
      Cookie: "paperarena_session=test-token",
    },
  });
  const inbox: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(msg));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    inbox.push(msg);
  });

  ws.on("error", (error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return {
    send(payload: object) {
      ws.send(JSON.stringify(payload));
    },
    waitFor<TMessage extends ServerMessage>(predicate: (msg: ServerMessage) => msg is TMessage) {
      const existingIndex = inbox.findIndex(predicate);
      if (existingIndex >= 0) {
        const [msg] = inbox.splice(existingIndex, 1);
        return Promise.resolve(msg as TMessage);
      }

      return new Promise<TMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message."));
        }, 2_000);
        waiters.push({
          predicate,
          resolve: (msg) => resolve(msg as TMessage),
          reject,
          timer,
        });
      });
    },
    close() {
      ws.close();
    },
  };
}
