import { CONFIG, type ArenaType, type WagerAmount } from "../config.js";
import type { ClientSession } from "../websocket/ClientSession.js";

export interface QueueEntry {
  session: ClientSession;
  username: string;
  color: string;
  joinedAt: number;
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
    this.leave(session);
    const key = queueKey(arena, wager);
    const bucket = this.buckets.get(key) ?? [];
    if (bucket.some((e) => e.session.id === session.id)) return null;

    bucket.push({ session, username, color, joinedAt: Date.now() });
    this.buckets.set(key, bucket);

    const needed = CONFIG.ARENAS[arena].players;
    this.broadcastQueueUpdate(key, bucket, needed);

    if (bucket.length >= needed) {
      const players = bucket.splice(0, needed);
      this.buckets.set(key, bucket);
      return { arena, wager, players };
    }
    return null;
  }

  leave(session: ClientSession) {
    for (const [key, bucket] of this.buckets) {
      const idx = bucket.findIndex((e) => e.session.id === session.id);
      if (idx >= 0) {
        bucket.splice(idx, 1);
        const arena = key.split(":")[0] as ArenaType;
        const needed = CONFIG.ARENAS[arena].players;
        this.broadcastQueueUpdate(key, bucket, needed);
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
}
