import type { GameState } from "./engine.js";
import { getTerritoryCounts, territoryPct, territoryValue } from "./engine.js";
import type { GameSnapshot, PlayerSnapshot } from "../types/protocol.js";

function b64FromInt8(arr: Int8Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

export function buildSnapshot(
  state: GameState,
  sessionToPlayer: Map<string, number>,
): GameSnapshot {
  const survivors = state.players.filter((p) => p.alive).length;
  const playerIdToSession = new Map<number, string>();
  for (const [sessionId, playerId] of sessionToPlayer) {
    playerIdToSession.set(playerId, sessionId);
  }

  const players: PlayerSnapshot[] = state.players.map((p) => ({
    id: p.id,
    sessionId: playerIdToSession.get(p.id) ?? "",
    name: p.name,
    color: p.color,
    alive: p.alive,
    x: p.x,
    y: p.y,
    dir: p.dir,
    kills: p.kills,
    bounty: p.bounty,
    territoryPct: territoryPct(state, p.id),
    territoryValue: territoryValue(state, p.id),
  }));

  return {
    cols: state.cols,
    rows: state.rows,
    tick: state.elapsed,
    tickMs: state.tickMs,
    timeRemainingMs: state.timeRemainingMs,
    totalPot: state.totalPot,
    wager: state.totalPot / state.players.length,
    survivors,
    players,
    territoryB64: b64FromInt8(state.territory),
    trailMapB64: b64FromInt8(state.trailMap),
  };
}
