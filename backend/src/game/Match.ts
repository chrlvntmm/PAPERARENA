import { nanoid } from "nanoid";
import { CONFIG, type ArenaType, type WagerAmount } from "../config.js";
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
  private pendingInputs = new Map<number, Dir>();
  private logicAcc = 0;
  private movementTickAcc = 0;
  private lastBroadcast = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private started = false;
  private countdownRemaining = CONFIG.PRE_MATCH_COUNTDOWN_MS;
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private preDeathCounts = new Map<number, number>();
  private onEnd?: () => void;

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
      entry.session.matchId = this.id;
      entry.session.playerId = i;
    });
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
    const existing = this.disconnectTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(session.id);
      const playerId = session.playerId;
      if (playerId == null || this.destroyed) return;
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

    this.disconnectTimers.set(session.id, timer);
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

    this.destroy();
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
