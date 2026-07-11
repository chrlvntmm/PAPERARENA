import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGame,
  endTerritoryMatch,
  getTerritoryCounts,
  setPlayerDir,
  territoryPct,
  territoryValue,
  tick,
  type Dir,
  type GameState,
  type Player,
} from "./engine.js";

test("builds PDF-aligned default cadence, fee, and arena durations", () => {
  const standard = buildGame({ players: 5, wager: 10, mode: "territory" });
  const mega = buildGame({ players: 10, wager: 20, mode: "territory" });

  assert.equal(standard.tickMs, 50);
  assert.equal(standard.fee, 1);
  assert.equal(standard.finalPrize, 49);
  assert.equal(standard.matchDurationMs, 150_000);
  assert.equal(standard.timeRemainingMs, 150_000);

  assert.equal(mega.tickMs, 50);
  assert.equal(mega.fee, 4);
  assert.equal(mega.finalPrize, 196);
  assert.equal(mega.matchDurationMs, 300_000);
  assert.equal(mega.timeRemainingMs, 300_000);
});

test("moves players from server-side directional input only", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  const player = state.players[0];
  const { x, y } = player;

  setPlayerDir(state, player.id, turn(player.dir));
  tick(state);

  assert.notDeepEqual({ x: player.x, y: player.y }, { x, y });
  assert.equal(state.elapsed, 1);
});

test("rejects direct reverse movement", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  const player = state.players[0];
  const original = player.dir;

  setPlayerDir(state, player.id, opposite(original));

  assert.equal(player.nextDir, original);
});

test("deterministically eliminates the owner when an enemy cuts their trail", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  neutralizeBoard(state);
  placePlayer(state.players[0], 10, 10, "left");
  placePlayer(state.players[1], 11, 11, "up");
  state.players[0].trail = [{ x: 11, y: 10 }];
  state.trailMap[10 * state.cols + 11] = 0;

  tick(state);

  assert.equal(state.players[0].alive, false);
  assert.equal(state.players[0].visible, false);
  assert.equal(state.players[1].alive, true);
  assert.equal(state.players[1].kills, 1);
  assert.deepEqual(state.deathEventsThisTick, [{ victimId: 0, cause: "killed", killerId: 1 }]);
  assert.notEqual(state.trailMap[10 * state.cols + 11], 0);
});

test("deterministically eliminates a player that hits their own exposed trail", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  neutralizeBoard(state);
  placePlayer(state.players[0], 10, 10, "right");
  placePlayer(state.players[1], 20, 20, "right");
  state.players[0].trail = [
    { x: 11, y: 10 },
    { x: 12, y: 10 },
    { x: 13, y: 10 },
  ];
  state.trailMap[10 * state.cols + 11] = 0;
  state.trailMap[10 * state.cols + 12] = 0;
  state.trailMap[10 * state.cols + 13] = 0;

  tick(state);

  assert.equal(state.players[0].alive, false);
  assert.deepEqual(state.deathEventsThisTick, [{ victimId: 0, cause: "self", killerId: null }]);
});

test("closes a loop and flood-fills enclosed territory", () => {
  const state = buildGame({ players: 2, wager: 10, mode: "territory" });
  neutralizeBoard(state);
  const player = state.players[0];
  placePlayer(player, 10, 11, "right");
  state.territory[11 * state.cols + 11] = 0;
  player.trail = [
    { x: 8, y: 8 },
    { x: 9, y: 8 },
    { x: 10, y: 8 },
    { x: 11, y: 8 },
    { x: 11, y: 9 },
    { x: 11, y: 10 },
    { x: 10, y: 10 },
    { x: 9, y: 10 },
    { x: 8, y: 10 },
    { x: 8, y: 9 },
  ];
  for (const cell of player.trail) {
    state.trailMap[cell.y * state.cols + cell.x] = 0;
  }

  tick(state);

  assert.equal(state.players[0].alive, true);
  assert.equal(player.trail.length, 0);
  assert.equal(state.territory[9 * state.cols + 9], 0);
  assert.equal(state.territory[9 * state.cols + 10], 0);
  assert.equal(state.trailMap[9 * state.cols + 8], -1);
});

test("timer end picks the player with the most backend-owned territory", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  neutralizeBoard(state);
  claimCells(state, 0, [
    [1, 1],
    [1, 2],
    [1, 3],
  ]);
  claimCells(state, 1, [
    [3, 1],
    [3, 2],
  ]);

  endTerritoryMatch(state);

  assert.equal(state.endedByTime, true);
  assert.equal(state.winnerId, 0);
});

test("territory match ends when one player remains alive", () => {
  const state = buildGame({ players: 2, wager: 5, mode: "territory" });
  neutralizeBoard(state);
  state.players[0].alive = false;
  state.players[0].visible = false;

  tick(state);

  assert.equal(state.endedByTime, false);
  assert.equal(state.winnerId, 1);
});

test("territory percentage and value come only from backend cell ownership", () => {
  const state = buildGame({ players: 2, wager: 10, mode: "territory" });
  neutralizeBoard(state);
  claimCells(state, 0, [
    [1, 1],
    [1, 2],
  ]);

  const expectedPct = (2 / (state.cols * state.rows)) * 100;
  const expectedValue = (2 / (state.cols * state.rows)) * state.totalMapValue;

  assert.equal(getTerritoryCounts(state)[0], 2);
  assert.equal(territoryPct(state, 0), expectedPct);
  assert.equal(territoryValue(state, 0), expectedValue);
});

function neutralizeBoard(state: GameState) {
  state.territory.fill(-1);
  state.trailMap.fill(-1);
  for (const player of state.players) {
    player.trail = [];
    player.alive = true;
    player.visible = true;
    player.kills = 0;
  }
}

function placePlayer(player: Player, x: number, y: number, dir: Dir) {
  player.x = x;
  player.y = y;
  player.dir = dir;
  player.nextDir = dir;
}

function claimCells(state: GameState, ownerId: number, cells: Array<[number, number]>) {
  for (const [x, y] of cells) {
    state.territory[y * state.cols + x] = ownerId;
  }
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
  return dir === "up" || dir === "down" ? "right" : "up";
}
