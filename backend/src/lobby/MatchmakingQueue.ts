import { CONFIG, type ArenaType, type WagerAmount } from "../config.js";
import type { ClientSession } from "../websocket/ClientSession.js";

export interface QueueEntry {
  session: ClientSession;
  username: string;
  color: string;
  joinedAt: number;
  identityKey: string;
}

export interface LockedLobby {
  arena: ArenaType;
  wager: WagerAmount;
  players: QueueEntry[];
}

function queueKey(arena: ArenaType, wager: WagerAmount): string {
  return `${arena}:${wager}`;
}

export class MatchmakingQueue {
  private buckets = new Map<string, QueueEntry[]>();

  join(
    session: ClientSession,
    arena: ArenaType,
    wager: WagerAmount,
    username: string,
    color: string,
  ): LockedLobby | null {
    const key = queueKey(arena, wager);
    const identityKey = queueIdentity(session);

    this.leaveByIdentity(identityKey, session.id);

    const bucket = this.buckets.get(key) ?? [];

    bucket.push({ session, username, color, joinedAt: Date.now(), identityKey });
    this.buckets.set(key, bucket);

    const needed = CONFIG.ARENAS[arena].players;
    if (bucket.length >= needed) {
      const players = bucket.splice(bucket.length - needed, needed);
      this.buckets.set(key, bucket);
      this.broadcastQueueUpdate(key, bucket, needed);
      this.broadcastLockedUpdate(key, players, needed);
      return { arena, wager, players };
    }

    this.broadcastQueueUpdate(key, bucket, needed);
    return null;
  }

  leave(session: ClientSession) {
    this.leaveBySessionId(session.id);
  }

  private leaveBySessionId(sessionId: string) {
    for (const [key, bucket] of this.buckets) {
      const idx = bucket.findIndex((e) => e.session.id === sessionId);
      if (idx >= 0) {
        bucket.splice(idx, 1);
        const arena = key.split(":")[0] as ArenaType;
        const needed = CONFIG.ARENAS[arena].players;
        this.broadcastQueueUpdate(key, bucket, needed);
        if (bucket.length === 0) {
          this.buckets.delete(key);
        }
      }
    }
  }

  private leaveByIdentity(identityKey: string, replacementSessionId?: string) {
    for (const [key, bucket] of this.buckets) {
      const idx = bucket.findIndex((e) => e.identityKey === identityKey);
      if (idx >= 0) {
        const [removed] = bucket.splice(idx, 1);
        if (replacementSessionId && removed.session.id !== replacementSessionId) {
          removed.session.send({
            type: "error",
            code: "QUEUE_REPLACED",
            message: "This wallet joined matchmaking from another tab.",
          });
        }
        const arena = key.split(":")[0] as ArenaType;
        const needed = CONFIG.ARENAS[arena].players;
        this.broadcastQueueUpdate(key, bucket, needed);
        if (bucket.length === 0) {
          this.buckets.delete(key);
        }
      }
    }
  }

  private broadcastQueueUpdate(key: string, bucket: QueueEntry[], needed: number) {
    const [arena, wagerStr] = key.split(":");
    bucket.forEach((entry, i) => {
      entry.session.send({
        type: "queue_update",
        position: i + 1,
        needed,
        arena,
        wager: Number(wagerStr),
      });
    });
  }

  private broadcastLockedUpdate(key: string, players: QueueEntry[], needed: number) {
    const [arena, wagerStr] = key.split(":");
    players.forEach((entry) => {
      entry.session.send({
        type: "queue_update",
        position: needed,
        needed,
        arena,
        wager: Number(wagerStr),
      });
    });
  }
}

function queueIdentity(session: ClientSession) {
  return session.walletId ?? session.walletAddress ?? session.userId ?? session.id;
}
