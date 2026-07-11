// PaperArena game engine — grid-based paper.io style territory capture.
import { playTerritoryPing } from "@/lib/audio";

export type Dir = "up" | "down" | "left" | "right";

export interface Player {
  id: number;
  name: string;
  color: string; // hex
  alive: boolean;
  // Defensive render gate: set to false the instant the player dies so the
  // canvas loop unconditionally skips drawing their head, name, and labels —
  // even if some other code path forgets to check `alive`.
  visible: boolean;
  bounty: number;
  // Animated/displayed bounty value (lerps toward `bounty` after kills).
  displayBounty: number;
  // Active rolling-counter animation, if any.
  bountyAnim: { from: number; to: number; elapsed: number; duration: number } | null;
  // Scale-pulse / color-flash timer (ms remaining; 0 = idle).
  bountyPulseMs: number;
  bountyPulseDuration: number;
  // Smoothly-rolling territory dollar value (territory mode).
  displayTerritoryValue: number;
  x: number; // grid cell
  y: number;
  dir: Dir;
  nextDir: Dir;
  trail: Array<{ x: number; y: number }>; // outside-territory path
  isHuman: boolean;
  kills: number;
  // AI
  aiTimer: number;
  moveAccumulator: number; // sub-cell for smoothness (0..1)
  // Hard exposure counters (bots): cells traveled since leaving safe zone,
  // and consecutive cells moved parallel to own border (neither closer to
  // nor further from home).
  stepsOutsideSafeZone: number;
  parallelSteps: number;
  // Compact-box enforcement: consecutive steps in same dir outside home,
  // number of 90° turns since leaving home, and a randomized box edge length
  // (2 or 3) that caps how many cells a bot may travel straight.
  straightSteps: number;
  turnsOutside: number;
  boxTarget: number;
  lastStepDir: Dir | null;
}

export interface KillPopup {
  playerId: number;
  life: number;
  maxLife: number;
}

export interface AbsorbParticle {
  // grid-space coordinates (cell units)
  startX: number;
  startY: number;
  killerId: number;
  life: number; // ms elapsed
  maxLife: number;
  color: string;
  size: number; // px
  jitterX: number;
  jitterY: number;
}

export type GameMode = "bounty" | "territory";

export interface GameConfig {
  players: number;
  wager: number;
  username?: string;
  color?: string;
  mode?: GameMode;
}

export interface GameState {
  cols: number;
  rows: number;
  cellSize: number;
  territory: Int8Array;
  trailMap: Int8Array;
  players: Player[];
  tickMs: number;
  elapsed: number;
  winnerId: number | null;
  finalPrize: number;
  totalPot: number;
  fee: number;
  particles: AbsorbParticle[];
  killPopups: KillPopup[];
  humanKills: number;
  humanBountyStolen: number;
  displayHumanBountyStolen: number;
  humanStolenAnim: { from: number; to: number; elapsed: number; duration: number } | null;
  mode: GameMode;
  totalMapValue: number;
  timeRemainingMs: number;
  endedByTime: boolean;
  // True when the match ended with zero survivors in territory mode: the full
  // pot is forfeited to the platform (no payouts to players or bots).
  houseClaim: boolean;
  // Total match length (territory mode); used so the UI can compute
  // "time survived" without re-deriving the constant.
  matchDurationMs: number;
  // How the human player died, set the tick the player is eliminated.
  // 'killed' = trail was cut by an opponent / head-on with another player
  // 'self'   = wall crash, own-trail crash, or any non-credited death
  humanDeathCause: 'killed' | 'self' | null;
}

const NEON_COLORS = [
  "#f4ff3a", // yellow (human)
  "#3afff0", // cyan
  "#ff3af0", // magenta
  "#3aff7a", // green
  "#ff7a3a", // orange
  "#7a3aff", // violet
  "#ff3a6b", // pink-red
  "#3a8cff", // blue
  "#aaff3a", // lime
  "#ff3a3a", // red
  "#3affc8",
  "#ffc83a",
  "#c83aff",
  "#3affff",
  "#ff8cc8",
  "#8cff3a",
  "#ff5a8c",
  "#5affc8",
  "#c8ff5a",
  "#5a8cff",
];

const BOT_NAME_POOL: string[] = [
  // Cool / Gamer
  "Shadow_Grid","NeonViper","AlphaX","MatrixRunner","Vortex","CryptoKing","Quantum_Slayer",
  "PhantomEdge","NightHawk","CipherZ","BlazeFury","Onyx_Ronin","StormBreaker","ZeroCool",
  // Funny / Memey
  "LaggingLuke","FreeBounty4U","TrailBlunderer","CtrlAltDefeat","Bot_Ross","WagerWaster",
  "NoobMaster69","SirLagsAlot","NotABot","RugMePlease","404_Skill","ToastedTrail",
  // Casual / Boring
  "Kevin1994","Sarah_B","Thomas_88","Just_Mark","David_NL","Emma_v","Peter_P",
  "Linda_91","Mike_77","Anna_K","Chris_T","Julia_M",
  // Crypto / Web3
  "SolWhale","GigaChad_SOL","PaperHands","Diamond_Trail","GasFee_Enjoyer","RakeCollector",
  "DegenApe","WenLambo","HODL_Hero","MintCondition","Satoshi_Jr","FloorSweeper",
];

export function generateBotNames(count: number, exclude: string[] = []): string[] {
  const taken = new Set(exclude.map(n => n.toLowerCase()));
  const pool = BOT_NAME_POOL.filter(n => !taken.has(n.toLowerCase()));
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = pool.slice(0, count);
  // Fallback if pool exhausted
  while (out.length < count) out.push(`Player_${Math.floor(Math.random() * 9999)}`);
  return out;
}

export function buildGame(cfg: GameConfig): GameState {
  // Scale map based on player count.
  const sizeMap: Record<number, { cols: number; cell: number }> = {
    2: { cols: 40, cell: 18 },
    5: { cols: 64, cell: 14 },
    10: { cols: 96, cell: 11 },
    20: { cols: 140, cell: 8 },
  };
  const s = sizeMap[cfg.players] ?? sizeMap[5];
  const cols = s.cols;
  const rows = s.cols; // square arena
  const cellSize = s.cell;

  const territory = new Int8Array(cols * rows).fill(-1);
  const trailMap = new Int8Array(cols * rows).fill(-1);

  const players: Player[] = [];
  const spawnPoints = pickSpawns(cfg.players, cols, rows);
  const humanName = cfg.username || "YOU";
  const botNames = generateBotNames(Math.max(0, cfg.players - 1), [humanName]);
  for (let i = 0; i < cfg.players; i++) {
    const sp = spawnPoints[i];
    const p: Player = {
      id: i,
      name: i === 0 ? humanName : (botNames[i - 1] ?? `Bot_${i}`),
      color: i === 0 && cfg.color ? cfg.color : NEON_COLORS[i % NEON_COLORS.length],
      alive: true,
      visible: true,
      bounty: cfg.wager,
      displayBounty: cfg.wager,
      bountyAnim: null,
      bountyPulseMs: 0,
      bountyPulseDuration: 0,
      displayTerritoryValue: 0,
      x: sp.x,
      y: sp.y,
      dir: sp.dir,
      nextDir: sp.dir,
      trail: [],
      isHuman: i === 0,
      kills: 0,
      aiTimer: 0,
      moveAccumulator: 0,
      stepsOutsideSafeZone: 0,
      parallelSteps: 0,
      straightSteps: 0,
      turnsOutside: 0,
      boxTarget: 2 + Math.floor(Math.random() * 2), // 2 or 3
      lastStepDir: null,

    };
    // seed 3x3 territory
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = p.x + dx, yy = p.y + dy;
        if (inBounds(xx, yy, cols, rows)) territory[yy * cols + xx] = i;
      }
    }
    players.push(p);
  }

  const totalPot = cfg.players * cfg.wager;
  const fee = totalPot * 0.05;
  return {
    cols, rows, cellSize,
    territory, trailMap, players,
    tickMs: 80,
    elapsed: 0,
    winnerId: null,
    finalPrize: totalPot - fee,
    totalPot,
    fee,
    particles: [],
    killPopups: [],
    humanKills: 0,
    humanBountyStolen: 0,
    displayHumanBountyStolen: 0,
    humanStolenAnim: null,
    mode: cfg.mode ?? "bounty",
    // Gross map value = full pot. The 5% rake is applied at cash-out, not here.
    totalMapValue: totalPot,
    timeRemainingMs: cfg.players <= 5 ? 150 * 1000 : 5 * 60 * 1000,
    endedByTime: false,
    houseClaim: false,
    matchDurationMs: cfg.players <= 5 ? 150 * 1000 : 5 * 60 * 1000,
    humanDeathCause: null,
  };
}

function pickSpawns(n: number, cols: number, rows: number) {
  const margin = 4;
  const pts: { x: number; y: number; dir: Dir }[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const cx = cols / 2, cy = rows / 2;
    const r = Math.min(cols, rows) / 2 - margin - 2;
    const x = Math.round(cx + Math.cos(angle) * r);
    const y = Math.round(cy + Math.sin(angle) * r);
    // direction roughly toward center
    const dxc = cx - x, dyc = cy - y;
    const dir: Dir = Math.abs(dxc) > Math.abs(dyc)
      ? (dxc > 0 ? "right" : "left")
      : (dyc > 0 ? "down" : "up");
    pts.push({ x, y, dir });
  }
  return pts;
}

function inBounds(x: number, y: number, cols: number, rows: number) {
  return x >= 0 && y >= 0 && x < cols && y < rows;
}

const DIRV: Record<Dir, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function opposite(a: Dir, b: Dir) {
  return (a === "up" && b === "down") || (a === "down" && b === "up") ||
         (a === "left" && b === "right") || (a === "right" && b === "left");
}

export function setPlayerDir(state: GameState, id: number, dir: Dir) {
  const p = state.players[id];
  if (!p || !p.alive) return;
  if (opposite(p.dir, dir)) return;
  p.nextDir = dir;
}

// Step one cell per tick.
export function tick(state: GameState) {
  const { cols, rows, territory, trailMap, players } = state;

  // 1) update directions and compute new positions (strict integer snap)
  const moves: Array<{ p: Player; nx: number; ny: number }> = [];
  const nextPos = new Map<number, { x: number; y: number }>();
  for (const p of players) {
    if (!p.alive) continue;
    p.dir = p.nextDir;
    const v = DIRV[p.dir];
    const nx = Math.floor(p.x + v.x);
    const ny = Math.floor(p.y + v.y);
    moves.push({ p, nx, ny });
    nextPos.set(p.id, { x: nx, y: ny });
  }

  // 2) resolve deaths.
  // Enemy-owned territory is deliberately NOT part of collision resolution:
  // colored territory cells are traversable like neutral cells and only cause
  // the mover to lay an exposed trail for stealing/raiding plays.
  const killed = new Set<number>();
  const killCredits = new Map<number, number>(); // victim -> killer (or -1 for none)

  // wall hits — STRICT bounds: must be < 0 or >= dimension
  for (const m of moves) {
    if (m.nx < 0 || m.ny < 0 || m.nx >= cols || m.ny >= rows) {
      killed.add(m.p.id);
      killCredits.set(m.p.id, -1);
    }
  }
  // trail hits — paper.io style:
  //   hitting own trail  -> self dies (BUT ignore the last 2 trail cells:
  //     these are directly connected to the player's back and would only
  //     be reached by a physically impossible 180° turn or a floating-point
  //     glitch. Ignoring them prevents spontaneous "ghost" self-crashes.)
  //   hitting another's trail -> THAT player (the trail owner) dies
  for (const m of moves) {
    if (m.nx < 0 || m.ny < 0 || m.nx >= cols || m.ny >= rows) continue;
    const t = trailMap[m.ny * cols + m.nx];
    if (t === -1) continue;
    if (t === m.p.id) {
      const tr = m.p.trail;
      const last = tr[tr.length - 1];
      const prev = tr[tr.length - 2];
      const isLast = last && last.x === m.nx && last.y === m.ny;
      const isPrev = prev && prev.x === m.nx && prev.y === m.ny;
      if (isLast || isPrev) continue; // safe — back-of-trail neighbour
      if (!killed.has(m.p.id)) {
        killed.add(m.p.id);
        killCredits.set(m.p.id, -1);
      }
    } else {
      if (!killed.has(t)) {
        killed.add(t);
        killCredits.set(t, m.p.id);
      }
    }
  }
  // head-on: two players moving into same cell -> both die
  const cellTargets = new Map<number, number[]>();
  for (const m of moves) {
    if (m.nx < 0 || m.ny < 0 || m.nx >= cols || m.ny >= rows) continue;
    const key = m.ny * cols + m.nx;
    const arr = cellTargets.get(key) ?? [];
    arr.push(m.p.id);
    cellTargets.set(key, arr);
  }
  for (const [, ids] of cellTargets) {
    if (ids.length > 1) {
      for (const id of ids) {
        if (!killed.has(id)) {
          killed.add(id);
          killCredits.set(id, -1);
        }
      }
    }
  }
  // Running into another player's head: only fatal if the other player is
  // STAYING in that cell (i.e. its next position is the same cell). If they
  // are vacating the cell this same tick, the attacker passes through safely.
  // This prevents "ghost deaths" from chasing an enemy that just moved away.
  for (const m of moves) {
    if (killed.has(m.p.id)) continue;
    for (const other of players) {
      if (other.id === m.p.id || !other.alive) continue;
      if (killed.has(other.id)) continue;
      if (other.x === m.nx && other.y === m.ny) {
        const np = nextPos.get(other.id);
        if (np && (np.x !== other.x || np.y !== other.y)) continue; // vacating
        killed.add(m.p.id);
        killCredits.set(m.p.id, other.id);
      }
    }
  }


  // 3) apply kills (absorb bounty + wipe territory & trail)
  for (const victimId of killed) {
    const victim = players[victimId];
    if (!victim.alive) continue;
    const killerId = killCredits.get(victimId);
    const killedByOther = killerId !== undefined && killerId >= 0 && !killed.has(killerId);
    if (killerId !== undefined && killerId >= 0) {
      const killer = players[killerId];
      if (killer && !killed.has(killer.id)) {
        triggerAbsorb(state, killer, victim, victim.bounty);
      }
    }
    // Record human death cause for the YOU LOST modal.
    if (victim.isHuman && state.humanDeathCause === null) {
      state.humanDeathCause = killedByOther ? 'killed' : 'self';
    }
    killPlayer(state, victim);
  }

  // 4) move survivors
  for (const m of moves) {
    if (killed.has(m.p.id)) continue;
    const prevX = m.p.x, prevY = m.p.y;
    m.p.x = m.nx; m.p.y = m.ny;
    const idx = m.ny * cols + m.nx;
    const onOwn = territory[idx] === m.p.id;
    if (!onOwn) {
      // lay trail
      if (trailMap[idx] === -1) {
        trailMap[idx] = m.p.id;
        m.p.trail.push({ x: m.nx, y: m.ny });
      }
      // ---- Hard exposure tracking (bots only need it, but cheap for all) ----
      m.p.stepsOutsideSafeZone += 1;
      // Parallel-wander detection: distance to nearest home cell unchanged?
      const homeNow = nearestHomeCell(state, m.p);
      if (homeNow) {
        const dPrev = Math.abs(homeNow.x - prevX) + Math.abs(homeNow.y - prevY);
        const dNow = Math.abs(homeNow.x - m.nx) + Math.abs(homeNow.y - m.ny);
        if (dNow === dPrev) m.p.parallelSteps += 1;
        else m.p.parallelSteps = 0;
      } else {
        m.p.parallelSteps = 0;
      }
      // Compact-box tracking: straight-run / turn counters outside home.
      if (m.p.lastStepDir === m.p.dir) {
        m.p.straightSteps += 1;
      } else {
        m.p.straightSteps = 1;
        if (m.p.lastStepDir !== null) m.p.turnsOutside += 1;
      }
      m.p.lastStepDir = m.p.dir;
    } else {
      // touched own safe zone -> reset exposure counters
      m.p.stepsOutsideSafeZone = 0;
      m.p.parallelSteps = 0;
      m.p.straightSteps = 0;
      m.p.turnsOutside = 0;
      m.p.lastStepDir = null;
      // Re-roll desired box edge each time we leave home so patterns vary.
      m.p.boxTarget = 2 + Math.floor(Math.random() * 2);
      if (m.p.trail.length > 0) {
        // returned home -> close territory
        closeTerritory(state, m.p);
      }
    }
  }

  // 5) win condition
  const alive = players.filter(p => p.alive);
  if (state.mode === "territory") {
    // Instant 100% map conquest -> immediate victory.
    if (state.winnerId === null) {
      const counts = getTerritoryCounts(state);
      const total = state.cols * state.rows;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] >= total && players[i].alive) {
          state.winnerId = i;
          state.endedByTime = false;
          break;
        }
      }
    }
    // Territory Control with no survivors: nobody cashes out — the platform
    // (house) retains 100% of the pot. We mark a sentinel winnerId of -1 and
    // a `houseClaim` flag the UI uses to render the "NO SURVIVORS" overlay.
    if (alive.length === 0 && state.winnerId === null) {
      state.winnerId = -1;
      state.houseClaim = true;
      state.endedByTime = false;
    }

  } else if (alive.length <= 1 && state.winnerId === null) {
    state.winnerId = alive[0]?.id ?? -1;
  }
}

// Count grid cells owned by each player.
export function getTerritoryCounts(state: GameState): number[] {
  const counts = new Array(state.players.length).fill(0);
  const total = state.cols * state.rows;
  for (let i = 0; i < total; i++) {
    const t = state.territory[i];
    if (t >= 0) counts[t]++;
  }
  return counts;
}

export function territoryValue(state: GameState, playerId: number): number {
  const counts = getTerritoryCounts(state);
  const total = state.cols * state.rows;
  return (counts[playerId] / total) * state.totalMapValue;
}

export function territoryPct(state: GameState, playerId: number): number {
  const counts = getTerritoryCounts(state);
  const total = state.cols * state.rows;
  return (counts[playerId] / total) * 100;
}

function pickTerritoryWinner(state: GameState): number {
  const counts = getTerritoryCounts(state);
  let best = -1, bestCount = -1;
  for (let i = 0; i < state.players.length; i++) {
    if (counts[i] > bestCount) { bestCount = counts[i]; best = i; }
  }
  return best;
}

// Called when the territory-mode timer hits zero. Freezes the match and
// awards the winner slot to the player with the most controlled cells.
export function endTerritoryMatch(state: GameState) {
  if (state.mode !== "territory" || state.winnerId !== null) return;
  state.endedByTime = true;
  state.winnerId = pickTerritoryWinner(state);
}

function closeTerritory(state: GameState, p: Player) {
  const { cols, rows, territory, trailMap } = state;
  // Track which cells are NEWLY claimed by this loop closure so that the
  // encirclement-kill check only fires on freshly enclosed opponents — never
  // on opponents who are merely traversing pre-existing enemy territory.
  const newlyClaimed = new Uint8Array(cols * rows);
  // Mark trail cells as territory
  for (const c of p.trail) {
    const idx = c.y * cols + c.x;
    if (territory[idx] !== p.id) newlyClaimed[idx] = 1;
    territory[idx] = p.id;
    trailMap[idx] = -1;
  }
  // Flood-fill from edges over cells not owned by p; everything not reached becomes p's.
  const visited = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (!inBounds(x, y, cols, rows)) return;
    const i = y * cols + x;
    if (visited[i]) return;
    if (territory[i] === p.id) return;
    visited[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < cols; x++) { push(x, 0); push(x, rows - 1); }
  for (let y = 0; y < rows; y++) { push(0, y); push(cols - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % cols, y = Math.floor(i / cols);
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  for (let i = 0; i < cols * rows; i++) {
    if (!visited[i] && territory[i] !== p.id) {
      newlyClaimed[i] = 1;
      territory[i] = p.id;
    }
  }
  p.trail = [];

  // Important: claiming territory never kills a player just because their head
  // overlaps a colored cell. The only active-player death checks live in
  // tick(): wall crash, own exposed trail, enemy cutting exposed trail, and
  // head collisions. This keeps enemy territory fully traversable for stealing.
  void newlyClaimed;

  p.bountyPulseMs = 250;
  p.bountyPulseDuration = 250;
  if (p.isHuman) playTerritoryPing();
}

// ---------------------------------------------------------------------------
// Bounty absorption: starts a rolling-counter animation, kicks a scale/color
// pulse, and spawns a small burst of particles that fly toward the killer.
// ---------------------------------------------------------------------------
function triggerAbsorb(state: GameState, killer: Player, victim: Player, amount: number) {
  if (amount <= 0) return;
  const newTotal = killer.bounty + amount;
  killer.bounty = newTotal;
  // In territory mode the kill does NOT increase the killer's live cash value
  // (their equity is derived from controlled cells). Skip the rolling-counter
  // animation on the floating label there; keep the pulse + particles for
  // visceral kill feedback.
  if (state.mode !== "territory") {
    const from = killer.bountyAnim
      ? killer.bountyAnim.to - (killer.bountyAnim.to - killer.bountyAnim.from) * (1 - killer.bountyAnim.elapsed / killer.bountyAnim.duration)
      : killer.displayBounty;
    killer.bountyAnim = { from, to: newTotal, elapsed: 0, duration: 250 };
  } else {
    killer.displayBounty = newTotal;
  }
  killer.bountyPulseMs = 250;
  killer.bountyPulseDuration = 250;
  killer.kills += 1;
  // Floating "+1 KILL" popup above the killer.
  state.killPopups.push({ playerId: killer.id, life: 0, maxLife: 500 });
  // Track human player stats.
  if (killer.isHuman) {
    state.humanKills += 1;
    const newStolen = state.humanBountyStolen + amount;
    const sFrom = state.humanStolenAnim
      ? state.humanStolenAnim.to - (state.humanStolenAnim.to - state.humanStolenAnim.from) * (1 - state.humanStolenAnim.elapsed / state.humanStolenAnim.duration)
      : state.displayHumanBountyStolen;
    state.humanBountyStolen = newStolen;
    state.humanStolenAnim = { from: sFrom, to: newStolen, elapsed: 0, duration: 600 };
  }
  // Spawn particle burst at victim's last known position, flying to killer.
  const count = 10;
  for (let i = 0; i < count; i++) {
    state.particles.push({
      startX: victim.x + 0.5,
      startY: victim.y + 0.5,
      killerId: killer.id,
      life: 0,
      maxLife: 450 + Math.random() * 250,
      color: victim.color,
      size: 3 + Math.random() * 3,
      jitterX: (Math.random() - 0.5) * 1.2,
      jitterY: (Math.random() - 0.5) * 1.2,
    });
  }
}

// Advance bounty rolling counters, pulse timers, and absorption particles.
// Call once per animation frame with dt in milliseconds.
export function updateAnimations(state: GameState, dt: number, territoryCounts?: number[]) {
  for (const p of state.players) {
    if (p.bountyAnim) {
      p.bountyAnim.elapsed += dt;
      const t = Math.min(1, p.bountyAnim.elapsed / p.bountyAnim.duration);
      p.displayBounty = p.bountyAnim.from + (p.bountyAnim.to - p.bountyAnim.from) * t;
      if (t >= 1) {
        p.displayBounty = p.bountyAnim.to;
        p.bountyAnim = null;
      }
    } else if (p.displayBounty !== p.bounty) {
      p.displayBounty = p.bounty;
    }
    if (p.bountyPulseMs > 0) {
      p.bountyPulseMs = Math.max(0, p.bountyPulseMs - dt);
    }
  }
  if (state.humanStolenAnim) {
    state.humanStolenAnim.elapsed += dt;
    const t = Math.min(1, state.humanStolenAnim.elapsed / state.humanStolenAnim.duration);
    state.displayHumanBountyStolen = state.humanStolenAnim.from + (state.humanStolenAnim.to - state.humanStolenAnim.from) * t;
    if (t >= 1) {
      state.displayHumanBountyStolen = state.humanStolenAnim.to;
      state.humanStolenAnim = null;
    }
  }
  // Particles: advance life, drop expired.
  if (state.particles.length) {
    const kept: AbsorbParticle[] = [];
    for (const pt of state.particles) {
      pt.life += dt;
      if (pt.life < pt.maxLife) kept.push(pt);
    }
    state.particles = kept;
  }
  // Kill popups: advance life, drop expired.
  if (state.killPopups.length) {
    const kept: KillPopup[] = [];
    for (const k of state.killPopups) {
      k.life += dt;
      if (k.life < k.maxLife) kept.push(k);
    }
    state.killPopups = kept;
  }
  // Smoothly roll each player's displayed territory dollar value toward the
  // live cell-count derived target. Triggers the rising-equity animation
  // whenever a player captures (or loses) territory.
  if (state.mode === "territory") {
    const total = state.cols * state.rows;
    const counts = territoryCounts ?? getTerritoryCounts(state);
    const k = 1 - Math.exp(-dt / 160); // ~160ms time-constant ease
    for (const p of state.players) {
      const target = (counts[p.id] / total) * state.totalMapValue;
      p.displayTerritoryValue += (target - p.displayTerritoryValue) * k;
      if (Math.abs(target - p.displayTerritoryValue) < 0.005) p.displayTerritoryValue = target;
    }
  }
}

// Wipe an eliminated player's trail AND captured territory from the board.
// Cells revert to neutral (-1), available for re-capture by others.
function wipePlayerFromBoard(state: GameState, p: Player) {
  const { cols, rows, territory, trailMap } = state;
  for (const c of p.trail) {
    if (inBounds(c.x, c.y, cols, rows)) trailMap[c.y * cols + c.x] = -1;
  }
  p.trail = [];
  const total = cols * rows;
  for (let i = 0; i < total; i++) {
    if (territory[i] === p.id) territory[i] = -1;
    if (trailMap[i] === p.id) trailMap[i] = -1;
  }
}

// Single canonical elimination path. Anywhere a player dies — wall crash,
// trail cut, head-on, encirclement — funnels through here so we cannot
// forget to scrub one piece of their footprint.
//
// Cleanup contract on death:
//   * board memory: trail array emptied + territory/trailMap cells released
//     (handled by wipePlayerFromBoard) — prevents ghost-collisions for
//     remaining survivors.
//   * render gates: alive=false AND visible=false — every draw path checks
//     these before touching head, label, or kill popup.
//   * spatial freeze: head teleported off-grid (-1,-1) as belt-and-suspenders
//     so even an un-gated draw can't paint a visible square.
//   * economics: bounty/displayBounty/territoryValue zeroed so the floating
//     green cash text and sidebar drop to $0.00 instantly.
//   * motion vectors frozen (moveAccumulator/aiTimer cleared).
function killPlayer(state: GameState, p: Player) {
  if (!p.alive && !p.visible) return; // already cleaned
  wipePlayerFromBoard(state, p);
  p.alive = false;
  p.visible = false;
  p.x = -1;
  p.y = -1;
  p.bounty = 0;
  p.displayBounty = 0;
  p.displayTerritoryValue = 0;
  p.bountyAnim = null;
  p.bountyPulseMs = 0;
  p.bountyPulseDuration = 0;
  p.moveAccumulator = 0;
  p.aiTimer = 0;
  p.stepsOutsideSafeZone = 0;
  p.parallelSteps = 0;
  p.straightSteps = 0;
  p.turnsOutside = 0;
  p.lastStepDir = null;
}

// ---------------------------------------------------------------------------
// Bot AI — strict deterministic frame-by-frame controller.
// No setInterval, no setTimeout, no random direction flips. Every frame we
// compute the single best legal 90-degree move using grid distances and
// threat vectors. Hard rules:
//   * Trail length > 5 outside home  =>  must move closer to home (RETREAT).
//   * 3-cell forward/side scan       =>  forbidden moves that crash.
//   * Hunt human only if reachable strictly faster than they can retreat.
// ---------------------------------------------------------------------------

const STRICT_TRAIL_CAP = 5;
const HUNT_RADIUS = 25;
const HUNT_RADIUS_KILL = 12;
const CRASH_SCAN = 3;
// Manhattan distance from a cell to nearest owned territory of `ownerId`.
function distToOwnTerritory(state: GameState, ownerId: number, x: number, y: number, maxR = 30): number {
  const { cols, rows, territory } = state;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const dx = r - Math.abs(dy);
      const pts = dx === 0 ? [[0, dy]] : [[dx, dy], [-dx, dy]];
      for (const [ox, oy] of pts) {
        const cx = x + ox, cy = y + oy;
        if (!inBounds(cx, cy, cols, rows)) continue;
        if (territory[cy * cols + cx] === ownerId) return r;
      }
    }
  }
  return Infinity;
}

function nearestHomeCell(state: GameState, p: Player): { x: number; y: number } | null {
  const { cols, rows, territory } = state;
  const maxR = Math.min(60, cols + rows);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const dx = r - Math.abs(dy);
      const candidates = dx === 0 ? [[0, dy]] : [[dx, dy], [-dx, dy]];
      for (const [ox, oy] of candidates) {
        const x = p.x + ox, y = p.y + oy;
        if (!inBounds(x, y, cols, rows)) continue;
        if (territory[y * cols + x] === p.id) return { x, y };
      }
    }
  }
  return null;
}

// Returns distance (1..maxRange) until a fatal cell in direction `dir` from
// (x,y) for player p: only walls and p's own trail are fatal. Enemy
// territory is NOT fatal — bots may cross into it to steal cells.
function rayDanger(state: GameState, p: Player, x: number, y: number, dir: Dir, maxRange = CRASH_SCAN): number {
  const { cols, rows, trailMap } = state;
  const v = DIRV[dir];
  let cx = x, cy = y;
  for (let k = 1; k <= maxRange; k++) {
    cx += v.x; cy += v.y;
    if (!inBounds(cx, cy, cols, rows)) return k;
    const i = cy * cols + cx;
    if (trailMap[i] === p.id) return k;
  }
  return Infinity;
}

// Closest exposed trail cell across ALL active entities (human + bots)
// within the 12-cell hunt radius, where the hunter can reach the trail
// strictly faster than the victim can retreat to home. Targets are ranked
// purely by interception distance — the mathematically closest, easiest
// trail to cut wins. Aggression is universal: bot-vs-bot is treated the
// same as bot-vs-human.
function findVictimTrailTarget(state: GameState, p: Player): { x: number; y: number; reach: number; victimId: number } | null {
  const { cols } = state;
  let best: { x: number; y: number; reach: number; victimId: number; score: number } | null = null;
  for (const victim of state.players) {
    if (victim.id === p.id || !victim.alive) continue;
    if (victim.trail.length === 0) continue;
    // Skip if victim is currently safe on home.
    if (state.territory[victim.y * cols + victim.x] === victim.id) continue;

    for (const c of victim.trail) {
      const d = Math.abs(c.x - p.x) + Math.abs(c.y - p.y);
      if (d > HUNT_RADIUS_KILL) continue;
      const victimHome = distToOwnTerritory(state, victim.id, c.x, c.y, HUNT_RADIUS_KILL + 5);
      // Strict: hunter reaches the trail in fewer steps than victim can retreat.
      if (d >= victimHome) continue;
      // Closest-target priority: smallest intercept distance wins. The
      // retreat-margin (victimHome - d) is only a tiebreaker for equal d.
      const score = -d * 10 + (victimHome - d) * 0.5;
      if (!best || score > best.score) best = { x: c.x, y: c.y, reach: d, victimId: victim.id, score };
    }
  }
  return best ? { x: best.x, y: best.y, reach: best.reach, victimId: best.victimId } : null;
}


// Nearest enemy head — pure threat-vector data (no behavior decision yet).
function nearestEnemy(state: GameState, p: Player): { dist: number; trailDist: number } {
  let dist = Infinity;
  let trailDist = Infinity;
  for (const o of state.players) {
    if (o.id === p.id || !o.alive) continue;
    const d = Math.abs(o.x - p.x) + Math.abs(o.y - p.y);
    if (d < dist) dist = d;
    for (const c of p.trail) {
      const dt = Math.abs(o.x - c.x) + Math.abs(o.y - c.y);
      if (dt < trailDist) trailDist = dt;
    }
  }
  return { dist, trailDist };
}

type AIMode = "EXPAND" | "HUNT" | "RETREAT" | "EVADE";

function decideDir(state: GameState, p: Player): Dir {
  const { cols, rows, territory, trailMap, players } = state;
  const onHome = territory[p.y * cols + p.x] === p.id;
  const trailLen = p.trail.length;
  const threats = nearestEnemy(state, p);
  const home = nearestHomeCell(state, p);
  const distHome = home ? Math.abs(home.x - p.x) + Math.abs(home.y - p.y) : Infinity;

  // Hard exposure ceiling — once a bot is >=5 cells deep into neutral
  // territory, mathematics takes over: no expansion, no hunt, only the
  // 90-degree turns that shorten distance to home.
  const exposure = p.stepsOutsideSafeZone;
  const overExposed = !onHome && exposure >= STRICT_TRAIL_CAP;
  const wanderingParallel = !onHome && p.parallelSteps >= 2;
  // Compact-box: after 2 turns outside, immediately head home to close loop.
  const twoTurnsDone = !onHome && p.turnsOutside >= 2;
  // Strict ban on long thin lines — forbid going straight if we've already
  // moved `boxTarget` cells (2 or 3) in the same direction outside home.
  const mustTurn = !onHome && p.straightSteps >= p.boxTarget;

  // ---- Mode selection (strict, deterministic) ----
  let mode: AIMode;
  if (overExposed || twoTurnsDone) {
    mode = "RETREAT";
  } else if (!onHome && trailLen > 0 && (threats.trailDist <= 3 || threats.dist <= 2)) {
    mode = "EVADE";
  } else if (!onHome && trailLen >= STRICT_TRAIL_CAP) {
    // Strict cell limit: forbid further expansion, force return.
    mode = "RETREAT";
  } else if (wanderingParallel) {
    // Forbid lateral drift along own border — commit to returning.
    mode = "RETREAT";
  } else {
    const hunt = (trailLen < STRICT_TRAIL_CAP - 1 && exposure < STRICT_TRAIL_CAP - 1)
      ? findVictimTrailTarget(state, p) : null;

    if (hunt) {
      mode = "HUNT";
      // stash target on player frame-local via closure below
      (p as Player & { _huntTarget?: { x: number; y: number } })._huntTarget = { x: hunt.x, y: hunt.y };
    } else {
      mode = "EXPAND";
      (p as Player & { _huntTarget?: { x: number; y: number } })._huntTarget = undefined;
    }
  }

  // ---- Target selection ----
  let target: { x: number; y: number } | null = null;
  if (mode === "RETREAT" || mode === "EVADE") {
    target = home;
  } else if (mode === "HUNT") {
    target = (p as Player & { _huntTarget?: { x: number; y: number } })._huntTarget ?? null;
  } else if (home) {
    // EXPAND: aim for a small loop just outside our home boundary.
    const v = DIRV[p.dir];
    target = { x: home.x + v.x * 3, y: home.y + v.y * 3 };
  }

  // ---- Score every legal 90-degree move (frame-by-frame, no randomness) ----
  const dirs: Dir[] = ["up", "down", "left", "right"];
  let best: Dir = p.dir;
  let bestScore = -Infinity;
  let anyLegal = false;

  for (const d of dirs) {
    if (opposite(p.dir, d)) continue;
    const v = DIRV[d];
    const nx = p.x + v.x, ny = p.y + v.y;
    if (!inBounds(nx, ny, cols, rows)) continue;
    const idx = ny * cols + nx;

    // HARD ban — stepping onto own trail = suicide.
    if (trailMap[idx] === p.id) continue;

    anyLegal = true;
    let score = 0;

    // 3-cell forward crash scan (rule 2). Severe penalty if next cell is fatal.
    const ray = rayDanger(state, p, nx, ny, d, CRASH_SCAN);
    if (ray <= 1) score -= 10000;       // would die next tick
    else if (ray === 2) score -= 60;
    else if (ray === 3) score -= 18;

    // Boundary awareness.
    const wallDist = Math.min(nx, ny, cols - 1 - nx, rows - 1 - ny);
    if (wallDist <= 0) score -= 200;
    else if (wallDist === 1) score -= 14;
    else if (wallDist === 2) score -= 4;
    score += Math.min(wallDist, 6) * 0.25;

    // Opportunistic kill: stepping ON an enemy trail eliminates them.
    if (trailMap[idx] !== -1 && trailMap[idx] !== p.id) {
      const ownerId = trailMap[idx];
      const ownerHome = distToOwnTerritory(state, ownerId, nx, ny, 20);
      if (ownerHome >= 2) {
        score += 90;
        const victim = players[ownerId];
        if (victim) score += Math.min(victim.bounty, 200) * 0.06;
      }
    }

    // Head proximity penalty.
    for (const o of players) {
      if (o.id === p.id || !o.alive) continue;
      const hd = Math.abs(o.x - nx) + Math.abs(o.y - ny);
      if (hd === 0) score -= 500;
      else if (hd === 1) score -= 14;
      else if (hd === 2) score -= 3;
    }

    // The compact-box / exposure / parallel-wander constraints apply to
    // farming. When the bot has locked a kill (mode === HUNT), aggression
    // takes priority — relax these so the bot can B-line the trail.
    const farming = mode !== "HUNT";

    // ---- Strict "small-loop" enforcement ----
    if (farming && !onHome && trailLen >= STRICT_TRAIL_CAP - 1 && home && territory[idx] !== p.id) {
      const newDist = Math.abs(home.x - nx) + Math.abs(home.y - ny);
      if (newDist >= distHome) score -= 800;
      else score += 40;
    }

    // ---- HARD ceiling: stepsOutsideSafeZone >= 5 ----
    // Even hunters must respect the absolute trail-cap, otherwise they
    // suicide running across the map.
    if (overExposed && home && territory[idx] !== p.id) {
      const newDist = Math.abs(home.x - nx) + Math.abs(home.y - ny);
      if (newDist >= distHome) score -= 9000;
      else score += 200;
    }

    // ---- Anti parallel-wander ----
    if (farming && wanderingParallel && home && territory[idx] !== p.id) {
      const newDist = Math.abs(home.x - nx) + Math.abs(home.y - ny);
      if (newDist === distHome) score -= 500;
      else if (newDist < distHome) score += 80;
    }

    // ---- Compact-box: ban long thin lines (farming only) ----
    if (farming && mustTurn && d === p.dir && territory[idx] !== p.id) {
      score -= 9000;
    }
    if (farming && !onHome && p.straightSteps >= 3 && d === p.dir && territory[idx] !== p.id) {
      score -= 20000;
    }
    if (farming && twoTurnsDone && home && territory[idx] !== p.id) {
      const newDist = Math.abs(home.x - nx) + Math.abs(home.y - ny);
      if (newDist < distHome) score += 300;
      else score -= 400;
    }


    // ---- Mode scoring ----
    if (mode === "EVADE" || mode === "RETREAT") {
      if (target) {
        const dh = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        score += 60 - dh * 2.2;
      }
      if (territory[idx] === p.id) score += 50;
      if (territory[idx] === -1) score -= 1.5;
    } else if (mode === "HUNT") {
      // B-line aggression: dominant weight on closing distance to the trail.
      if (target) {
        const dh = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        score += 120 - dh * 4.5;
      }
      // While hunting, stepping into enemy territory is fine (it's not fatal).
      if (territory[idx] !== -1 && territory[idx] !== p.id) score += 0.5;
    } else {
      // EXPAND — tight loops next to home. Enemy territory is scored exactly
      // like neutral territory: it is traversable and only starts an exposed
      // trail, enabling cross-border stealing without spontaneous deaths.
      if (territory[idx] !== p.id) score += 3.0;
      if (target) {
        const dh = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        score += Math.max(0, 6 - dh * 0.4);
      }
      if (home && territory[idx] !== p.id) {
        const dh = Math.abs(home.x - nx) + Math.abs(home.y - ny);
        if (dh > STRICT_TRAIL_CAP) score -= (dh - STRICT_TRAIL_CAP) * 2.5;
      }
    }


    // Mild preference for straight-line motion when the lane is clear.
    if (d === p.dir && ray > CRASH_SCAN) score += 0.5;

    // Deterministic tiebreaker: prefer current dir, then up/right/down/left.
    score += d === p.dir ? 0.05 : 0;

    if (score > bestScore) { bestScore = score; best = d; }
  }

  // Last-resort: if every non-reverse move is illegal (boxed in), allow reverse
  // direction by re-scanning without the opposite filter.
  if (!anyLegal) {
    for (const d of dirs) {
      const v = DIRV[d];
      const nx = p.x + v.x, ny = p.y + v.y;
      if (!inBounds(nx, ny, cols, rows)) continue;
      if (trailMap[ny * cols + nx] === p.id) continue;
      best = d; break;
    }
  }

  return best;
}

// Called every frame for every bot. No timers, no random gating — pure
// deterministic decision from the current grid state.
export function aiThink(state: GameState, p: Player, _dtMs: number) {
  void _dtMs;
  p.aiTimer = 0;
  p.nextDir = decideDir(state, p);
}


