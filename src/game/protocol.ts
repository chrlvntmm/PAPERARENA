import type { Dir } from "./engine";

export const WS_URL =
  import.meta.env.VITE_WS_URL;

if (!WS_URL) {
  throw new Error("VITE_WS_URL is required.");
}

export type ClientMessage =
  | { type: "join_queue"; arena: "standard" | "mega"; wager: number; username: string; color: string }
  | { type: "leave_queue" }
  | { type: "input"; dir: Dir; seq: number }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "auth_ok"; sessionId: string }
  | { type: "auth_fail"; reason: string }
  | { type: "queue_update"; position: number; needed: number; arena: string; wager: number }
  | { type: "match_start"; matchId: string; playerId: number; tick: number; snapshot: GameSnapshot }
  | { type: "state"; tick: number; serverTime: number; snapshot: GameSnapshot }
  | { type: "eliminated"; playerId: number; payload: EliminationPayload }
  | { type: "match_end"; payload: MatchEndPayload }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number };

export interface PlayerSnapshot {
  id: number;
  sessionId: string;
  name: string;
  color: string;
  alive: boolean;
  x: number;
  y: number;
  dir: Dir;
  kills: number;
  bounty: number;
  territoryPct: number;
  territoryValue: number;
}

export interface GameSnapshot {
  cols: number;
  rows: number;
  tick: number;
  tickMs: number;
  timeRemainingMs: number;
  totalPot: number;
  wager: number;
  survivors: number;
  players: PlayerSnapshot[];
  territoryB64: string;
  trailMapB64: string;
  events?: GameEvent[];
}

export interface EliminationPayload {
  cause: "killed" | "self";
  killerName?: string;
  mapPct: number;
  valueLost: number;
  kills: number;
  timeSurvivedMs: number;
}

export interface MatchEndPayload {
  reason: "timer" | "ultra" | "house_claim" | "last_standing";
  winnerId: number | null;
  winnerName: string;
  isYou: boolean;
  mapPct: number;
  mapValue: number;
  grossPayout: number;
  platformFee: number;
  netPayout: number;
  ultra: boolean;
  houseClaim: boolean;
  kills: number;
  timeSurvivedMs: number;
}

export type GameEvent =
  | { kind: "kill"; killerId: number; victimId: number }
  | { kind: "territory_close"; playerId: number };
