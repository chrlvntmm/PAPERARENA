import { buildGame, type Dir, type GameState, type Player } from "./engine";
import type { GameSnapshot } from "./protocol";

export function b64ToInt8(b64: string): Int8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int8Array(bytes.buffer);
}

function playerDefaults(id: number, dir: Dir): Omit<Player, "id" | "name" | "color" | "alive" | "x" | "y" | "dir" | "kills" | "bounty" | "isHuman" | "displayBounty" | "displayTerritoryValue"> {
  return {
    visible: true,
    nextDir: dir,
    trail: [],
    bountyAnim: null,
    bountyPulseMs: 0,
    bountyPulseDuration: 0,
    aiTimer: 0,
    moveAccumulator: 0,
    stepsOutsideSafeZone: 0,
    parallelSteps: 0,
    straightSteps: 0,
    turnsOutside: 0,
    boxTarget: 2,
    lastStepDir: null,
  };
}

export function createRenderState(
  snap: GameSnapshot,
  myPlayerId: number,
  playerCount: number,
  wager: number,
): GameState {
  const state = buildGame({ players: playerCount, wager, mode: "territory" });
  state.cellSize = 22;
  applySnapshot(state, snap, myPlayerId);
  return state;
}

export function applySnapshot(state: GameState, snap: GameSnapshot, myPlayerId: number): void {
  state.cols = snap.cols;
  state.rows = snap.rows;
  state.elapsed = snap.tick;
  state.timeRemainingMs = snap.timeRemainingMs;
  state.totalPot = snap.totalPot;
  state.totalMapValue = snap.totalPot;
  state.mode = "territory";
  state.territory = b64ToInt8(snap.territoryB64);
  state.trailMap = b64ToInt8(snap.trailMapB64);

  const prevById = new Map(state.players.map((p) => [p.id, p]));

  state.players = snap.players.map((sp) => {
    const prev = prevById.get(sp.id);
    const defaults = playerDefaults(sp.id, sp.dir);
    return {
      ...defaults,
      id: sp.id,
      name: sp.name,
      color: sp.color,
      alive: sp.alive,
      visible: sp.alive,
      x: sp.x,
      y: sp.y,
      dir: sp.dir,
      nextDir: sp.dir,
      kills: sp.kills,
      bounty: sp.bounty,
      displayBounty: sp.bounty,
      displayTerritoryValue: sp.territoryValue,
      isHuman: sp.id === myPlayerId,
      bountyAnim: prev?.bountyAnim ?? null,
      bountyPulseMs: prev?.bountyPulseMs ?? 0,
      bountyPulseDuration: prev?.bountyPulseDuration ?? 0,
      trail: [],
    };
  });
}
