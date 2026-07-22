import { nanoid } from "nanoid";
import { CONFIG, type ArenaType, type WagerAmount } from "../config.js";
import { settleMatchFunds } from "../auth/escrow.service.js";
import type { ClientSession } from "../websocket/ClientSession.js";
import type { QueueEntry } from "../lobby/MatchmakingQueue.js";
import type { EliminationPayload, MatchEndPayload } from "../types/protocol.js";
import {
  buildGame,
  tick,
  setPlayerDir,
  endTerritoryMatch,
  getTerritoryCounts,
  forceEliminate,
  type GameState,
  type Dir,
} from "./engine.js";
import { buildSnapshot } from "./snapshot.js";

export class Match {
  readonly id = nanoid();
  readonly state: GameState;
  private sessions = new Map<string, ClientSession>();
  private sessionToPlayer = new Map<string, number>();
  private playerToSession = new Map<number, string>();
  private playerWallets = new Map<number, string>();
  /** Stable identity (walletId preferred) → player slot for reconnect. */
  private identityToPlayer = new Map<string, number>();
  private playerToIdentity = new Map<number, string>();
  private pendingInputs = new Map<number, Dir>();
  private logicAcc = 0;
  private movementTickAcc = 0;
  private lastBroadcast = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private started = false;
  private countdownRemaining = CONFIG.PRE_MATCH_COUNTDOWN_MS;
  /** Disconnect grace timers keyed by playerId (survives session replacement). */
  private disconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private preDeathCounts = new Map<number, number>();
  private onEnd?: () => void;
  private onChainMatchIdHex?: string;
  private settlementStarted = false;

  constructor(
    arena: ArenaType,
    wager: WagerAmount,
    entries: QueueEntry[],
    onEnd?: () => void,
  ) {
    this.onEnd = onEnd;
    const cfg = CONFIG.ARENAS[arena];
    this.state = buildGame({
      players: cfg.players,
      wager,
      mode: "territory",
      tickMs: CONFIG.LOGIC_TICK_MS * CONFIG.MOVEMENT_TICKS_PER_STEP,
      platformFee: CONFIG.PLATFORM_FEE,
      matchDurationMs: cfg.durationMs,
    });

    this.state.matchDurationMs = cfg.durationMs;
    this.state.timeRemainingMs = cfg.durationMs;

    const nameCounts = new Map<string, number>();
    entries.forEach((entry, i) => {
      const p = this.state.players[i];
      p.name = uniqueMatchName(entry.username, nameCounts);
      p.color = entry.color;
      p.isHuman = true;

      this.sessions.set(entry.session.id, entry.session);
      this.sessionToPlayer.set(entry.session.id, i);
      this.playerToSession.set(i, entry.session.id);
      if (entry.session.walletAddress) {
        this.playerWallets.set(i, entry.session.walletAddress);
      }
      const identity = entry.identityKey || entry.session.walletId || entry.session.walletAddress || entry.session.id;
      this.identityToPlayer.set(identity, i);
      this.playerToIdentity.set(i, identity);
      entry.session.matchId = this.id;
      entry.session.playerId = i;
    });
  }

  /** Identities used for reconnect lookup after create. */
  getIdentityKeys(): string[] {
    return [...this.identityToPlayer.keys()];
  }

  hasIdentity(identityKey: string): boolean {
    return this.identityToPlayer.has(identityKey);
  }

  setOnChainMatchId(onChainMatchIdHex?: string) {
    this.onChainMatchIdHex = onChainMatchIdHex;
  }

  /** Deploy drain / SIGTERM: end match by current territory and settle escrow. */
  forceEndForShutdown() {
    if (this.destroyed) return;
    if (this.state.winnerId === null) {
      endTerritoryMatch(this.state);
    }
    this.endMatch();
  }

  start() {
    if (this.interval) return;
    const tickLoopMs = 1000 / CONFIG.BROADCAST_HZ;
    this.lastBroadcast = performance.now();
    this.interval = setInterval(() => this.frame(tickLoopMs), tickLoopMs);
  }

  private frame(dtMs: number) {
    if (this.destroyed) return;

    if (!this.started) {
      this.countdownRemaining -= dtMs;
      if (this.countdownRemaining <= 0) {
        this.started = true;
        for (const [sessionId, playerId] of this.sessionToPlayer) {
          const session = this.sessions.get(sessionId);
          if (!session) continue;
          session.send({
            type: "match_start",
            matchId: this.id,
            playerId,
            tick: this.state.elapsed,
            snapshot: buildSnapshot(this.state, this.sessionToPlayer),
          });
        }
      }
      return;
    }

    for (const [playerId, dir] of this.pendingInputs) {
      setPlayerDir(this.state, playerId, dir);
    }
    this.pendingInputs.clear();

    this.logicAcc += dtMs;
    while (this.logicAcc >= CONFIG.LOGIC_TICK_MS) {
      this.logicAcc -= CONFIG.LOGIC_TICK_MS;
      this.runLogicTick();
      if (this.destroyed) return;
    }

    const now = performance.now();
    if (now - this.lastBroadcast >= CONFIG.BROADCAST_MS) {
      this.lastBroadcast = now;
      this.broadcastState();
    }
  }

  private runLogicTick() {
    const s = this.state;
    if (s.winnerId !== null) return;

    if (s.mode === "territory") {
      s.timeRemainingMs = Math.max(0, s.timeRemainingMs - CONFIG.LOGIC_TICK_MS);
      if (s.timeRemainingMs <= 0) {
        endTerritoryMatch(s);
        this.endMatch();
        return;
      }
    }

    this.movementTickAcc += 1;
    if (this.movementTickAcc < CONFIG.MOVEMENT_TICKS_PER_STEP) return;
    this.movementTickAcc = 0;

    const preCounts = getTerritoryCounts(s);
    for (const p of s.players) {
      if (p.alive) this.preDeathCounts.set(p.id, preCounts[p.id]);
    }

    tick(s);

    for (const event of s.deathEventsThisTick) {
      this.notifyElimination(event.victimId, event.cause, event.killerId);
    }

    if (s.winnerId !== null) {
      this.endMatch();
    }
  }

  handleInput(session: ClientSession, dir: Dir) {
    if (!this.started || this.destroyed) return;
    const playerId = session.playerId;
    if (playerId == null) return;
    const p = this.state.players[playerId];
    if (!p?.alive) return;
    this.pendingInputs.set(playerId, dir);
  }

  handleDisconnect(session: ClientSession) {
    const playerId = session.playerId;
    if (playerId == null || this.destroyed) return;

    // Detach this socket; slot stays reserved for reconnect within grace.
    this.sessions.delete(session.id);
    this.sessionToPlayer.delete(session.id);
    if (this.playerToSession.get(playerId) === session.id) {
      this.playerToSession.delete(playerId);
    }

    const existing = this.disconnectTimers.get(playerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(playerId);
      if (this.destroyed) return;
      // Reconnected under a new session — cancel elimination.
      if (this.playerToSession.has(playerId)) return;
      const p = this.state.players[playerId];
      if (!p?.alive) return;

      const preCounts = getTerritoryCounts(this.state);
      this.preDeathCounts.set(playerId, preCounts[playerId]);
      forceEliminate(this.state, playerId);
      this.notifyElimination(playerId, "self", null);

      if (this.state.winnerId !== null) {
        this.endMatch();
      }
    }, CONFIG.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(playerId, timer);
  }

  /**
   * Rebind a new authenticated socket to this player within disconnect grace.
   * Returns false if identity is not in this match or grace already expired (eliminated).
   */
  tryReconnect(session: ClientSession): boolean {
    if (this.destroyed) return false;
    const identity =
      session.walletId ?? session.walletAddress ?? session.userId ?? session.id;
    const playerId = this.identityToPlayer.get(identity);
    if (playerId == null) return false;

    const p = this.state.players[playerId];
    if (!p) return false;

    // Cancel pending force-elim.
    const timer = this.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(playerId);
    }

    // Drop any stale session still mapped to this slot.
    const oldSessionId = this.playerToSession.get(playerId);
    if (oldSessionId && oldSessionId !== session.id) {
      this.sessions.delete(oldSessionId);
      this.sessionToPlayer.delete(oldSessionId);
    }

    this.sessions.set(session.id, session);
    this.sessionToPlayer.set(session.id, playerId);
    this.playerToSession.set(playerId, session.id);
    session.matchId = this.id;
    session.playerId = playerId;

    const snapshot = buildSnapshot(this.state, this.sessionToPlayer);
    session.send({
      type: "match_resume",
      matchId: this.id,
      playerId,
      tick: this.state.elapsed,
      snapshot,
    });

    return true;
  }

  private notifyElimination(
    playerId: number,
    cause: "killed" | "self",
    killerId: number | null,
  ) {
    const sessionId = this.playerToSession.get(playerId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return;

    const s = this.state;
    const p = s.players[playerId];
    const total = s.cols * s.rows;
    const held = this.preDeathCounts.get(playerId) ?? 0;

    const payload: EliminationPayload = {
      cause,
      killerName:
        killerId != null && killerId >= 0
          ? s.players[killerId]?.name
          : undefined,
      mapPct: (held / total) * 100,
      valueLost: (held / total) * s.totalMapValue,
      kills: p.kills,
      timeSurvivedMs: Math.max(0, s.matchDurationMs - s.timeRemainingMs),
    };

    session.send({ type: "eliminated", playerId, payload });
  }

  private endMatch() {
    if (this.destroyed) return;

    const s = this.state;
    const counts = getTerritoryCounts(s);
    const total = s.cols * s.rows;

    for (const [sessionId, playerId] of this.sessionToPlayer) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      const p = s.players[playerId];
      const mapPct = (counts[playerId] / total) * 100;
      const mapValue = (counts[playerId] / total) * s.totalMapValue;
      const ultra = !s.endedByTime && mapPct >= 99.999;
      const gross = p.alive ? mapValue : 0;
      const fee = gross * CONFIG.PLATFORM_FEE;
      const net = +(gross - fee).toFixed(2);

      let reason: MatchEndPayload["reason"] = "timer";
      if (s.houseClaim) reason = "house_claim";
      else if (ultra) reason = "ultra";
      else if (!s.endedByTime && s.winnerId === playerId) reason = "last_standing";

      const winner =
        s.winnerId != null && s.winnerId >= 0 ? s.players[s.winnerId] : null;

      const payload: MatchEndPayload = {
        reason,
        winnerId: s.winnerId,
        winnerName: s.houseClaim
          ? "HOUSE"
          : winner?.name ?? "Nobody",
        isYou: playerId === session.playerId,
        mapPct,
        mapValue,
        grossPayout: gross,
        platformFee: fee,
        netPayout: net,
        ultra,
        houseClaim: s.houseClaim,
        kills: p.kills,
        timeSurvivedMs: Math.max(0, s.matchDurationMs - s.timeRemainingMs),
      };

      session.send({ type: "match_end", payload });
    }

    void this.settleAfterEnd(counts, total);
    this.destroy();
  }

  private async settleAfterEnd(counts: number[], totalCells: number) {
    if (this.settlementStarted) return;
    this.settlementStarted = true;

    const players = [...this.playerWallets.entries()].map(([playerIndex, walletAddress]) => {
      const p = this.state.players[playerIndex];
      return {
        playerIndex,
        walletAddress,
        alive: Boolean(p?.alive),
        territoryCells: counts[playerIndex] ?? 0,
      };
    });

    if (players.length === 0) return;

    try {
      const result = await settleMatchFunds({
        matchId: this.id,
        onChainMatchIdHex: this.onChainMatchIdHex,
        players,
        totalCells,
      });
      if (!result.ok) {
        console.error(`[match ${this.id}] settlement failed:`, result.reason);
      }
    } catch (error) {
      console.error(`[match ${this.id}] settlement error:`, error);
    }
  }

  private broadcastState() {
    this.broadcast({
      type: "state",
      tick: this.state.elapsed,
      serverTime: Date.now(),
      snapshot: buildSnapshot(this.state, this.sessionToPlayer),
    });
  }

  private broadcast(msg: object) {
    for (const session of this.sessions.values()) {
      session.send(msg);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.movementTickAcc = 0;
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    this.pendingInputs.clear();
    this.sessions.clear();
    this.sessionToPlayer.clear();
    this.playerToSession.clear();
    this.preDeathCounts.clear();
    this.onEnd?.();
  }
}

function uniqueMatchName(rawName: string, counts: Map<string, number>) {
  const base = (rawName.trim() || "PLAYER").slice(0, 16);
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  if (count === 1) return base;

  const suffix = `_${count}`;
  return `${base.slice(0, 16 - suffix.length)}${suffix}`;
}
