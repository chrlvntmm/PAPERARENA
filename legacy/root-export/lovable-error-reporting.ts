import { useEffect, useRef, useState } from "react";
import { buildGame, tick, aiThink, setPlayerDir, updateAnimations, endTerritoryMatch, getTerritoryCounts, type Dir, type GameMode, type GameState } from "./engine";
import { playClickSound, playLoseSound, playWinSound } from "@/lib/audio";
import { Clock, Skull, Eye } from "lucide-react";
import logoAsset from "@/assets/paper-arena-logo-v2.png.asset.json";

interface Props {
  players: number;
  wager: number;
  username?: string;
  color?: string;
  mode?: GameMode;
  onExit: (result: { won: boolean; payout: number }) => void;
}

const KEY_MAP: Record<string, Dir> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", a: "left", s: "down", d: "right",
  W: "up", A: "left", S: "down", D: "right",
  z: "up", q: "left", Z: "up", Q: "left",
};

// Constant tactical zoom — cell size in CSS pixels during play.
const PLAY_CELL = 22;
const COUNTDOWN_MS = 5000;

type Interp = { fx: number; fy: number };

export default function Game({ players, wager, username, color, mode = "bounty", onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const rafRef = useRef<number | null>(null);
  const viewRef = useRef<{ w: number; h: number; camX: number; camY: number; cell: number }>({ w: 800, h: 800, camX: 0, camY: 0, cell: PLAY_CELL });
  const startedRef = useRef(false);
  const spectatingRef = useRef(false);
  const prevPosRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const interpRef = useRef<Map<number, Interp>>(new Map());
  const enterSpectateRef = useRef<() => void>(() => {});
  const winSoundPlayedRef = useRef(false);
  
  const [, force] = useState(0);
  const [countdown, setCountdown] = useState(5);
  const [started, setStarted] = useState(false);
  const [spectating, setSpectating] = useState(false);
  const [showLostModal, setShowLostModal] = useState(false);
  const [lostStats, setLostStats] = useState<{ mapPct: number; valueLost: number; kills: number; timeSurvivedMs: number; cause: 'killed' | 'self' } | null>(null);
  const [winner, setWinner] = useState<null | { name: string; bounty: number; color: string; isHuman: boolean; kills: number; mapPct: number; mapValue: number; timeSurvivedMs: number; ultra: boolean }>(null);

  // Compute the human payout (net of 5% rake) for the current state.
  const RAKE = 0.05;
  const computeGross = (won: boolean): number => {
    const s = stateRef.current;
    if (!s) return 0;
    if (s.mode === "territory") {
      const me = s.players[0];
      if (!me.alive) return 0;
      const counts = getTerritoryCounts(s);
      const total = s.cols * s.rows;
      return (counts[0] / total) * s.totalMapValue;
    }
    return won ? s.totalPot : 0;
  };
  const computePayout = (won: boolean): number => +(computeGross(won) * (1 - RAKE)).toFixed(2);



  useEffect(() => {
    const state = buildGame({ players, wager, username, color, mode });
    state.cellSize = PLAY_CELL;
    stateRef.current = state;
    startedRef.current = false;
    spectatingRef.current = false;
    setStarted(false);
    setSpectating(false);
    setShowLostModal(false);
    winSoundPlayedRef.current = false;
    setCountdown(5);
    prevPosRef.current = new Map(state.players.map(p => [p.id, { x: p.x, y: p.y }]));
    interpRef.current = new Map(state.players.map(p => [p.id, { fx: p.x, fy: p.y }]));

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const fitSpectateCell = () => {
      const pad = 40;
      return Math.max(3, Math.floor(Math.min((viewRef.current.w - pad) / state.cols, (viewRef.current.h - pad) / state.rows)));
    };

    const resize = () => {
      const w = Math.min(window.innerWidth - 320, 1200);
      const h = window.innerHeight - 100;
      canvas.width = w;
      canvas.height = h;
      viewRef.current.w = w;
      viewRef.current.h = h;
      if (spectatingRef.current) {
        viewRef.current.cell = fitSpectateCell();
        state.cellSize = viewRef.current.cell;
        viewRef.current.camX = (state.cols * viewRef.current.cell - w) / 2;
        viewRef.current.camY = (state.rows * viewRef.current.cell - h) / 2;
      } else {
        const me = state.players[0];
        viewRef.current.cell = PLAY_CELL;
        state.cellSize = PLAY_CELL;
        viewRef.current.camX = me.x * PLAY_CELL - w / 2;
        viewRef.current.camY = me.y * PLAY_CELL - h / 2;
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const onKey = (e: KeyboardEvent) => {
      if (!startedRef.current || spectatingRef.current) return;
      const d = KEY_MAP[e.key];
      if (!d) return;
      e.preventDefault();
      setPlayerDir(state, 0, d);
    };
    window.addEventListener("keydown", onKey);

    const startedAt = performance.now();
    let last = startedAt;
    let tickAcc = 0;
    let hudAcc = 0;

    const enterSpectate = () => {
      spectatingRef.current = true;
      setSpectating(true);
      const target = fitSpectateCell();
      viewRef.current.cell = target;
      state.cellSize = target;
      // camera target is centered arena; resize() handles, but also set here
      viewRef.current.camX = (state.cols * target - viewRef.current.w) / 2;
      viewRef.current.camY = (state.rows * target - viewRef.current.h) / 2;
    };
    enterSpectateRef.current = enterSpectate;

    const loop = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;

      if (!startedRef.current) {
        const elapsed = now - startedAt;
        const remaining = COUNTDOWN_MS - elapsed;
        const secs = Math.max(0, Math.ceil(remaining / 1000));
        setCountdown(secs);
        if (remaining <= 0) {
          startedRef.current = true;
          setStarted(true);
          last = now;
        }
      } else {
        tickAcc += dt;
        hudAcc += dt;
        // Territory mode timer
        if (state.mode === "territory" && state.winnerId === null) {
          state.timeRemainingMs = Math.max(0, state.timeRemainingMs - dt);
          if (state.timeRemainingMs <= 0) {
            endTerritoryMatch(state);
          }
        }
        if (state.winnerId === null) {
          for (const p of state.players) {
            if (p.alive && !p.isHuman) aiThink(state, p, dt);
          }
          while (tickAcc >= state.tickMs) {
            tickAcc -= state.tickMs;
            for (const p of state.players) {
              prevPosRef.current.set(p.id, { x: p.x, y: p.y });
            }
            const humanWasAlive = state.players[0].alive;
            // Snapshot human's territory BEFORE tick — if they die this tick,
            // wipePlayerFromBoard clears their cells before we can read them.
            const preCounts = humanWasAlive && state.mode === "territory" ? getTerritoryCounts(state) : null;
            tick(state);
            if (humanWasAlive && !state.players[0].alive && !spectatingRef.current) {
              const total = state.cols * state.rows;
              const heldCells = preCounts ? preCounts[0] : 0;
              const mapPct = (heldCells / total) * 100;
              const valueLost = (heldCells / total) * state.totalMapValue;
              const timeSurvivedMs = Math.max(0, state.matchDurationMs - state.timeRemainingMs);
              const cause: 'killed' | 'self' = state.humanDeathCause === 'killed' ? 'killed' : 'self';
              setLostStats({ mapPct, valueLost, kills: state.players[0].kills, timeSurvivedMs, cause });
              setShowLostModal(true);
              playLoseSound();
              // Do NOT force winnerId here. If bots are still alive, the match
              // continues (player spectates) and tick() will set winnerId only
              // when bots resolve the game. If the human was actually the last
              // survivor, tick() already set winnerId=-1 + houseClaim=true.
            }
          }
        }
        if (hudAcc > 100) { hudAcc = 0; force(v => v + 1); }
      }

      // animations (rolling bounty, pulses, particles) — always advance
      updateAnimations(state, dt);

      // compute interpolated positions
      const alpha = startedRef.current ? Math.min(1, tickAcc / state.tickMs) : 0;
      for (const p of state.players) {
        const prev = prevPosRef.current.get(p.id) ?? { x: p.x, y: p.y };
        // only interpolate if neighbors (skip teleport/wipe edge cases)
        const dx = p.x - prev.x, dy = p.y - prev.y;
        const adjacent = Math.abs(dx) + Math.abs(dy) === 1;
        const fx = adjacent ? prev.x + dx * alpha : p.x;
        const fy = adjacent ? prev.y + dy * alpha : p.y;
        interpRef.current.set(p.id, { fx, fy });
      }

      // camera
      const cell = viewRef.current.cell;
      if (spectatingRef.current) {
        const tx = (state.cols * cell - viewRef.current.w) / 2;
        const ty = (state.rows * cell - viewRef.current.h) / 2;
        viewRef.current.camX += (tx - viewRef.current.camX) * 0.12;
        viewRef.current.camY += (ty - viewRef.current.camY) * 0.12;
      } else {
        const me = state.players[0];
        const meI = interpRef.current.get(me.id) ?? { fx: me.x, fy: me.y };
        const targetX = meI.fx * cell - viewRef.current.w / 2;
        const targetY = meI.fy * cell - viewRef.current.h / 2;
        const lerp = startedRef.current ? 0.2 : 1;
        viewRef.current.camX += (targetX - viewRef.current.camX) * lerp;
        viewRef.current.camY += (targetY - viewRef.current.camY) * lerp;
      }

      render(ctx, state, viewRef.current, interpRef.current);

      if (state.winnerId !== null && !winner) {
        const counts = getTerritoryCounts(state);
        const totalCells = state.cols * state.rows;
        // House-claim with the human as the last to self-eliminate: skip the
        // winner overlay entirely — the YOU LOST modal handles it instead.
        // Suppress the winner overlay whenever the YOU LOST modal owns the
        // screen — that includes house-claim-last-death AND any case where the
        // human died earlier and bots later resolved the match.
        const humanDeadOverlayOwns = !state.players[0].alive && !spectatingRef.current;
        const humanIsDeadLast = humanDeadOverlayOwns;
        // In territory mode: a human survivor always sees VICTORY at match end,
        // even if a bot technically holds more cells — they cash out their %.
        const humanSurvived = state.mode === "territory" && state.players[0].alive && !spectatingRef.current;
        const w = humanSurvived
          ? state.players[0]
          : (state.winnerId >= 0 ? state.players[state.winnerId] : null);
        const mapPct = w ? (counts[w.id] / totalCells) * 100 : 0;
        const mapValue = w ? (counts[w.id] / totalCells) * state.totalMapValue : 0;
        if (!humanIsDeadLast) {
          const timeSurvivedMs = Math.max(0, state.matchDurationMs - state.timeRemainingMs);
          const ultra = !state.endedByTime && mapPct >= 99.999;
          setWinner(w
            ? { name: w.name, bounty: w.bounty, color: w.color, isHuman: w.isHuman, kills: w.kills, mapPct, mapValue, timeSurvivedMs, ultra }
            : { name: state.houseClaim ? "HOUSE" : "Nobody", bounty: 0, color: state.houseClaim ? "#ff3a6b" : "#888", isHuman: false, kills: 0, mapPct: 0, mapValue: 0, timeSurvivedMs, ultra: false });
          if (w?.isHuman && !winSoundPlayedRef.current) {
            winSoundPlayedRef.current = true;
            playWinSound();
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
    };
  }, [players, wager, username, color, mode]);

  const state = stateRef.current;
  const alivePlayers = state ? state.players.filter(p => p.alive) : [];
  const isTerritory = state?.mode === "territory";
  const territoryCounts = state ? getTerritoryCounts(state) : [];
  const totalCells = state ? state.cols * state.rows : 1;
  const valueFor = (id: number) => state ? (territoryCounts[id] / totalCells) * state.totalMapValue : 0;
  const pctFor = (id: number) => state ? (territoryCounts[id] / totalCells) * 100 : 0;
  const sorted = state
    ? [...state.players].sort((a, b) => isTerritory ? (valueFor(b.id) - valueFor(a.id)) : (b.bounty - a.bounty))
    : [];
  const humanPct = state ? pctFor(0) : 0;
  const timeMs = state?.timeRemainingMs ?? 0;
  const timeStr = `${String(Math.floor(timeMs / 60000)).padStart(2, "0")}:${String(Math.floor((timeMs % 60000) / 1000)).padStart(2, "0")}`;
  const showSpectate = showLostModal && !winner && state && state.winnerId === null && state.timeRemainingMs > 0 && alivePlayers.length > 0;

  return (
    <div className="min-h-screen w-full flex" style={{ background: "#0a0b0d" }}>
      <div className="flex-1 flex items-center justify-center p-4 relative">
        <canvas ref={canvasRef} className="block neon-border rounded" />

        {isTerritory && started && !winner && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 px-6 py-2 rounded-md border backdrop-blur-md flex items-center gap-3" style={{ background: "rgba(10,11,13,0.6)", borderColor: timeMs < 30000 ? "#ff3a6b" : "#f4ff3a", boxShadow: `0 0 24px ${timeMs < 30000 ? "rgba(255,58,107,0.5)" : "rgba(244,255,58,0.35)"}` }}>
            <span className="font-display text-[10px] tracking-[0.35em] text-white/70">TIME</span>
            <span className="font-display text-3xl tabular-nums" style={{ color: timeMs < 30000 ? "#ff3a6b" : "#f4ff3a", textShadow: `0 0 14px ${timeMs < 30000 ? "#ff3a6b" : "#f4ff3a"}` }}>{timeStr}</span>
          </div>
        )}
        {!started && !winner && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="text-xs tracking-[0.5em] text-muted-foreground mb-4">MATCH STARTS IN</div>
              <div
                key={countdown}
                className="font-display animate-[pulse_1s_ease-in-out]"
                style={{
                  fontSize: countdown === 0 ? "9rem" : "12rem",
                  lineHeight: 1,
                  color: "#f4ff3a",
                  textShadow: "0 0 40px #f4ff3a, 0 0 80px #f4ff3a",
                  letterSpacing: countdown === 0 ? "0.1em" : "0",
                }}
              >
                {countdown === 0 ? "GO!" : countdown}
              </div>
            </div>
          </div>
        )}

        {spectating && !winner && (
          <>
            <div className="absolute top-6 left-6 flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 backdrop-blur-md" style={{ background: "rgba(10,11,13,0.55)" }}>
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "#ff3a6b", boxShadow: "0 0 10px #ff3a6b" }} />
              <span className="font-display text-[11px] tracking-[0.35em] text-white/90">SPECTATING LIVE</span>
            </div>
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
              <button
                onClick={() => { playClickSound(); onExit({ won: false, payout: computePayout(false) }); }}
                className="px-7 py-3 rounded-md font-display tracking-[0.25em] text-xs border backdrop-blur-md transition hover:scale-[1.03]"
                style={{
                  background: "rgba(10,11,13,0.6)",
                  borderColor: "#f4ff3a",
                  color: "#f4ff3a",
                  boxShadow: "0 0 24px rgba(244,255,58,0.35), inset 0 0 12px rgba(244,255,58,0.15)",
                }}
              >
                ◀ RETURN TO LOBBY
              </button>
            </div>
          </>
        )}

        {showLostModal && !winner && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-md z-30 p-6">
            <div
              className="rounded-[36px] px-8 py-10 border max-w-[420px] w-full"
              style={{
                background: "#0a0b0d",
                borderColor: "rgba(244,255,58,0.55)",
                filter: "drop-shadow(0 0 28px rgba(244,255,58,0.55)) drop-shadow(0 0 70px rgba(244,255,58,0.35))",
              }}
            >
              <div className="text-center">
                <div
                  className="font-display text-5xl md:text-6xl mb-3"
                  style={{ color: "#ff2a3d", textShadow: "0 0 18px rgba(255,42,61,0.85), 0 0 42px rgba(255,42,61,0.55)", letterSpacing: "0.08em" }}
                >
                  YOU LOST
                </div>
                <div className="font-display text-xs md:text-sm tracking-[0.35em] text-white mb-8">
                  {lostStats?.cause === 'killed' ? "YOU GOT KILLED" : "YOU KILLED YOURSELF"}
                </div>
              </div>

              <div
                className="rounded-2xl px-5 py-5"
                style={{ background: "#06070a", border: "1px solid rgba(255,255,255,0.06)" }}
              >
                <StatRow
                  label="TIME SURVIVED"
                  icon={<Clock className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                  value={formatClock(lostStats?.timeSurvivedMs ?? 0)}
                />
                <StatRow
                  label="KILLS"
                  icon={<Skull className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                  value={String(lostStats?.kills ?? state?.players[0].kills ?? 0)}
                />
                <StatRow
                  label="MAP % LOST"
                  value={`${(lostStats?.mapPct ?? humanPct).toFixed(0)}%`}
                />
                <StatRow
                  label="MAP VALUE LOST"
                  value={`$${(lostStats?.valueLost ?? 0).toFixed(2)}`}
                  valueColor="#ff2a3d"
                  valueShadow="0 0 14px rgba(255,42,61,0.6)"
                  last
                />
              </div>

              <div className="flex gap-3 mt-7 justify-center">
                {showSpectate && (
                  <button
                    onClick={() => { playClickSound(); setShowLostModal(false); enterSpectateRef.current(); }}
                    className="flex-1 px-5 py-3 rounded-xl font-display tracking-[0.25em] text-[11px] border transition hover:scale-[1.03] flex items-center justify-center gap-2"
                    style={{
                      background: "#0a0b0d",
                      borderColor: "rgba(255,255,255,0.18)",
                      color: "#ffffff",
                    }}
                  >
                    SPECTATE <Eye className="w-4 h-4" strokeWidth={2.2} />
                  </button>
                )}
                <button
                  onClick={() => { playClickSound(); onExit({ won: false, payout: computePayout(false) }); }}
                  className="flex-1 px-5 py-3 rounded-xl font-display tracking-[0.25em] text-[11px] border transition hover:scale-[1.03]"
                  style={{
                    background: "#0a0b0d",
                    borderColor: "rgba(255,255,255,0.18)",
                    color: "#ffffff",
                  }}
                >
                  RETURN TO LOBBY
                </button>
              </div>
            </div>
          </div>
        )}

        {winner && state?.houseClaim && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-md">
            <div
              className="rounded-xl p-10 text-center border max-w-lg w-[92%]"
              style={{
                background: "linear-gradient(180deg, #131418 0%, #0a0b0d 100%)",
                borderColor: "rgba(255,58,107,0.55)",
                boxShadow: "0 0 60px rgba(255,58,107,0.4), inset 0 0 30px rgba(255,58,107,0.08)",
              }}
            >
              <div className="text-[11px] tracking-[0.5em] text-white/50 mb-3">MATCH OVER</div>
              <div className="font-display text-4xl md:text-5xl mb-3" style={{ color: "#ff3a6b", textShadow: "0 0 24px #ff3a6b, 0 0 48px rgba(255,58,107,0.5)", letterSpacing: "0.06em" }}>
                NO SURVIVORS
              </div>
              <div className="font-display text-lg tracking-[0.25em] text-white/80 mb-6">HOUSE CLAIMS THE POT</div>
              <div className="font-display text-5xl mb-2 text-white/30 line-through tabular-nums">${state.totalMapValue.toFixed(2)}</div>
              <div className="text-[11px] tracking-[0.35em] text-white/50 mb-6">FORFEITED TO PLATFORM</div>
              <button onClick={() => { playClickSound(); onExit({ won: false, payout: 0 }); }} className="mt-2 px-8 py-3 neon-border rounded font-display tracking-widest text-sm hover:bg-white/5">
                RETURN TO LOBBY
              </button>
            </div>
          </div>
        )}

        {winner && !state?.houseClaim && (() => {
          const isHumanWin = winner.isHuman;
          const ultra = winner.ultra && isHumanWin;
          const net = winner.mapValue * (1 - RAKE);
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-md p-6">
              <div
                className="rounded-[36px] px-8 py-10 border max-w-[420px] w-full"
                style={{
                  background: "#0a0b0d",
                  borderColor: "rgba(244,255,58,0.55)",
                  filter: "drop-shadow(0 0 28px rgba(244,255,58,0.55)) drop-shadow(0 0 70px rgba(244,255,58,0.35))",
                }}
              >
                <div className="text-center">
                  {ultra && (
                    <div
                      className="font-display text-3xl md:text-4xl mb-1"
                      style={{ color: "#f4ff3a", textShadow: "0 0 18px rgba(244,255,58,0.85), 0 0 42px rgba(244,255,58,0.55)", letterSpacing: "0.08em" }}
                    >
                      ULTRA
                    </div>
                  )}
                  <div
                    className="font-display text-5xl md:text-6xl mb-3"
                    style={{ color: isHumanWin ? "#f4ff3a" : winner.color, textShadow: `0 0 18px ${isHumanWin ? "rgba(244,255,58,0.85)" : winner.color}, 0 0 42px ${isHumanWin ? "rgba(244,255,58,0.55)" : "rgba(255,255,255,0.2)"}`, letterSpacing: "0.08em" }}
                  >
                    {isHumanWin ? "VICTORY" : `${winner.name} WINS`}
                  </div>
                  <div className="font-display text-xs md:text-sm tracking-[0.3em] text-white mb-8">
                    {isHumanWin
                      ? (ultra
                          ? <>YOU CONQUERED <span style={{ color: "#f4ff3a", textShadow: "0 0 10px rgba(244,255,58,0.7)" }}>100%</span> OF MAP</>
                          : "YOU SURVIVED THE TIMER")
                      : "MATCH COMPLETE"}
                  </div>
                </div>

                <div
                  className="rounded-2xl px-5 py-5"
                  style={{ background: "#06070a", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <StatRow
                    label="TIME SURVIVED"
                    icon={<Clock className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                    value={formatClock(winner.timeSurvivedMs)}
                  />
                  <StatRow
                    label="KILLS"
                    icon={<Skull className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                    value={String(winner.kills)}
                  />
                  <StatRow
                    label="MAP % CONQUERED"
                    value={`${Math.round(winner.mapPct)}%`}
                    valueColor={ultra ? "#f4ff3a" : undefined}
                    valueShadow={ultra ? "0 0 12px rgba(244,255,58,0.7)" : undefined}
                  />
                  <StatRow
                    label="MAP VALUE WON"
                    value={`$${winner.mapValue.toFixed(2)}`}
                  />
                  <StatRow
                    twoLine={["YOUR PRICE", "- PLATFORM FEE (5%)"]}
                    value={`$${net.toFixed(2)}`}
                    valueColor="#f4ff3a"
                    valueShadow="0 0 14px rgba(244,255,58,0.7)"
                    last
                  />
                </div>

                <div className="flex justify-center mt-7">
                  <button
                    onClick={() => { playClickSound(); onExit({ won: isHumanWin, payout: computePayout(isHumanWin) }); }}
                    className="px-8 py-3 rounded-xl font-display tracking-[0.25em] text-[11px] border transition hover:scale-[1.03]"
                    style={{
                      background: "#0a0b0d",
                      borderColor: "rgba(255,255,255,0.18)",
                      color: "#ffffff",
                    }}
                  >
                    RETURN TO LOBBY
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      <aside className="w-[320px] border-l border-border/50 p-5 flex flex-col gap-5" style={{ background: "#0c0d10" }}>
        <div className="flex flex-col items-center text-center">
          <img src={logoAsset.url} alt="PaperArena" className="w-full h-auto object-contain" />
          <div className="font-display text-[10px] tracking-[0.35em] text-white/60 mt-1">{"\n"}</div>
        </div>
        <div className="text-center font-display tracking-[0.35em] text-white text-base uppercase">
          {arenaLabel(players)}
        </div>
        <div
          className="rounded-2xl px-4 py-3 grid grid-cols-3"
          style={{
            background: "linear-gradient(180deg, rgba(20,22,26,0.95) 0%, rgba(14,15,18,0.95) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02), 0 6px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div className="flex flex-col items-start">
            <div className="font-display text-[9px] tracking-[0.2em] text-white/70">MAP VALUE</div>
            <div className="font-mono font-bold text-base mt-1 tabular-nums" style={{ color: "#f4ff3a", textShadow: "0 0 10px rgba(244,255,58,0.6)" }}>
              ${state?.totalPot.toFixed(2) ?? "0.00"}
            </div>
          </div>
          <div className="flex flex-col items-center border-x border-white/10">
            <div className="font-display text-[9px] tracking-[0.2em] text-white/70">WAGER</div>
            <div className="font-mono font-bold text-base mt-1 text-white tabular-nums">${wager.toFixed(2)}</div>
          </div>
          <div className="flex flex-col items-end">
            <div className="font-display text-[9px] tracking-[0.2em] text-white/70">PLAYERS ALIVE</div>
            <div className="font-mono font-bold text-base mt-1 text-white tabular-nums">{alivePlayers.length}/{players}</div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-1">
          <div className="font-display text-[12px] tracking-[0.18em] text-white">LIVE ARENA LEADERBOARD</div>
          <PodiumIcon />
        </div>
        <div className="flex-1 overflow-auto space-y-2 pr-1">
          {sorted.map((p, idx) => {
            const rank = idx + 1;
            const pct = pctFor(p.id);
            const displayVal = isTerritory ? valueFor(p.id) : p.displayBounty;
            const badge = rankBadgeStyle(rank);
            return (
              <div
                key={p.id}
                className={`rounded-md px-2.5 py-2 ${p.alive ? "" : "opacity-40"}`}
                style={{
                  background: p.isHuman ? "rgba(244,255,58,0.07)" : "rgba(255,255,255,0.025)",
                  border: p.isHuman ? "1px solid rgba(244,255,58,0.55)" : "1px solid rgba(255,255,255,0.06)",
                  boxShadow: p.isHuman ? "0 0 14px rgba(244,255,58,0.25), inset 0 0 8px rgba(244,255,58,0.08)" : "none",
                }}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className="font-display text-[10px] font-black tracking-wider px-1.5 py-0.5 rounded shrink-0 tabular-nums"
                    style={{
                      background: badge.bg,
                      color: badge.fg,
                      border: `1px solid ${badge.border}`,
                      boxShadow: badge.glow,
                      minWidth: 26,
                      textAlign: "center",
                    }}
                  >
                    #{rank}
                  </span>
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
                  <span className="flex-1 font-mono text-xs truncate" style={{ color: p.isHuman ? "#f4ff3a" : "#fff" }}>{p.name}</span>
                  <span
                    className="font-mono text-xs font-bold tabular-nums shrink-0"
                    style={{
                      color: p.alive ? "#00FF66" : "#3a6b4a",
                      textShadow: p.bountyPulseMs > 0 ? "0 0 10px #00FF66" : "0 0 4px #004d1a",
                      transform: p.bountyPulseMs > 0 ? `scale(${1 + 0.3 * (p.bountyPulseMs / Math.max(1, p.bountyPulseDuration))})` : "scale(1)",
                      transformOrigin: "right center",
                      display: "inline-block",
                      transition: "transform 80ms linear",
                    }}
                  >
                    ${displayVal.toFixed(2)}
                  </span>
                </div>
                <div
                  className="relative h-1.5 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-out"
                    style={{
                      width: `${Math.max(0, Math.min(100, pct))}%`,
                      background: `linear-gradient(90deg, ${p.color}cc, ${p.color})`,
                      boxShadow: `0 0 8px ${p.color}cc`,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="font-mono text-[10px] text-white/50 tabular-nums">{pct.toFixed(1)}%</span>
                  <span className="font-mono text-[10px] tabular-nums flex items-center gap-1" style={{ color: "#ff3a6b" }}>
                    <span style={{ textShadow: "0 0 6px rgba(255,58,107,0.6)" }}>☠</span>
                    <span className="text-white/80">KILLS:</span>
                    <span className="font-bold" style={{ color: "#ff3a6b" }}>{p.kills}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-muted-foreground tracking-wider leading-relaxed border-t border-border/40 pt-3">
          ARROWS · WASD · ZQSD<br />
          Turn 90°. Cross a rival's trail to ELIMINATE them and absorb their bounty. Close your loop to claim territory; trap rivals inside to kill them instantly.
        </div>
      </aside>
    </div>
  );
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function StatRow({
  label, value, icon, twoLine, valueColor, valueShadow, last,
}: {
  label?: string;
  value: string;
  icon?: React.ReactNode;
  twoLine?: [string, string];
  valueColor?: string;
  valueShadow?: string;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${last ? "" : "border-b border-white/[0.06]"}`}>
      <div className="flex items-center gap-2 min-w-0">
        {twoLine ? (
          <div className="flex flex-col leading-tight">
            <span className="font-display text-[10px] tracking-[0.25em] text-white">{twoLine[0]}</span>
            <span className="font-display text-[9px] tracking-[0.22em] text-white/55 mt-0.5">{twoLine[1]}</span>
          </div>
        ) : (
          <span className="font-display text-[10px] tracking-[0.25em] text-white">{label}</span>
        )}
        {icon}
      </div>
      <span
        className="font-display text-base tabular-nums"
        style={{ color: valueColor ?? "#ffffff", textShadow: valueShadow }}
      >
        {value}
      </span>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border border-border/60 rounded px-3 py-2">
      <div className="text-[9px] tracking-[0.3em] text-muted-foreground">{label}</div>
      <div className={`font-display text-lg ${accent ? "neon-text" : "neon-text-white"}`}>{value}</div>
    </div>
  );
}

function KillStat({ label, value, accent }: { label: string; value: number | string; accent: string }) {
  const str = String(value);
  const sizeClass = str.length >= 7 ? "text-2xl" : str.length >= 5 ? "text-3xl" : "text-4xl";
  return (
    <div className="rounded-md border px-3 py-3" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.12)" }}>
      <div className="text-[9px] tracking-[0.3em] text-white/60 whitespace-nowrap">{label}</div>
      <div className={`font-display ${sizeClass} tabular-nums mt-1 leading-none`} style={{ color: accent, textShadow: `0 0 18px ${accent}` }}>{value}</div>
    </div>
  );
}

function rankBadgeStyle(rank: number) {
  if (rank === 1) return { bg: "rgba(244,255,58,0.18)", fg: "#f4ff3a", border: "rgba(244,255,58,0.7)", glow: "0 0 10px rgba(244,255,58,0.55), inset 0 0 6px rgba(244,255,58,0.2)" };
  if (rank === 2) return { bg: "rgba(220,225,235,0.14)", fg: "#e8ecf3", border: "rgba(220,225,235,0.55)", glow: "0 0 8px rgba(220,225,235,0.4)" };
  if (rank === 3) return { bg: "rgba(205,127,50,0.18)", fg: "#ffb072", border: "rgba(205,127,50,0.55)", glow: "0 0 8px rgba(205,127,50,0.45)" };
  return { bg: "rgba(255,255,255,0.04)", fg: "rgba(255,255,255,0.55)", border: "rgba(255,255,255,0.1)", glow: "none" };
}

function arenaLabel(players: number) {
  if (players === 2) return "Duel Arena (1v1)";
  if (players === 5) return "Standard Arena";
  if (players === 10) return "Mega Arena";
  if (players === 20) return "Chaos Arena";
  return `${players} Players`;
}

function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  view: { w: number; h: number; camX: number; camY: number; cell: number },
  interp: Map<number, Interp>,
) {
  const { cols, rows, players, territory, trailMap } = state;
  const cellSize = view.cell;
  const W = view.w;
  const H = view.h;
  // Precompute territory counts once per frame for territory mode labels.
  const tCounts = new Array<number>(players.length).fill(0);
  if (state.mode === "territory") {
    const total = cols * rows;
    for (let i = 0; i < total; i++) { const t = territory[i]; if (t >= 0) tCounts[t]++; }
  }
  const totalCells = cols * rows;

  ctx.fillStyle = "#0a0b0d";
  ctx.fillRect(0, 0, W, H);

  const camX = view.camX;
  const camY = view.camY;
  const x0 = Math.max(0, Math.floor(camX / cellSize));
  const y0 = Math.max(0, Math.floor(camY / cellSize));
  const x1 = Math.min(cols, Math.ceil((camX + W) / cellSize));
  const y1 = Math.min(rows, Math.ceil((camY + H) / cellSize));

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) {
    const px = Math.round(x * cellSize - camX) + 0.5;
    ctx.moveTo(px, Math.max(0, Math.round(0 - camY)));
    ctx.lineTo(px, Math.min(H, Math.round(rows * cellSize - camY)));
  }
  for (let y = y0; y <= y1; y++) {
    const py = Math.round(y * cellSize - camY) + 0.5;
    ctx.moveTo(Math.max(0, Math.round(0 - camX)), py);
    ctx.lineTo(Math.min(W, Math.round(cols * cellSize - camX)), py);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(244,255,58,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    Math.round(0 - camX) + 0.5,
    Math.round(0 - camY) + 0.5,
    cols * cellSize,
    rows * cellSize,
  );

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = territory[y * cols + x];
      if (t === -1) continue;
      const c = players[t].color;
      ctx.fillStyle = hexAlpha(c, 0.22);
      ctx.fillRect(x * cellSize - camX, y * cellSize - camY, cellSize, cellSize);
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const id = territory[y * cols + x];
      if (id === -1) continue;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        const isOut = nx < 0 || ny < 0 || nx >= cols || ny >= rows || territory[ny * cols + nx] !== id;
        if (isOut) {
          ctx.strokeStyle = hexAlpha(players[id].color, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (nx === x + 1) { ctx.moveTo((x + 1) * cellSize - camX, y * cellSize - camY); ctx.lineTo((x + 1) * cellSize - camX, (y + 1) * cellSize - camY); }
          else if (nx === x - 1) { ctx.moveTo(x * cellSize - camX, y * cellSize - camY); ctx.lineTo(x * cellSize - camX, (y + 1) * cellSize - camY); }
          else if (ny === y + 1) { ctx.moveTo(x * cellSize - camX, (y + 1) * cellSize - camY); ctx.lineTo((x + 1) * cellSize - camX, (y + 1) * cellSize - camY); }
          else if (ny === y - 1) { ctx.moveTo(x * cellSize - camX, y * cellSize - camY); ctx.lineTo((x + 1) * cellSize - camX, y * cellSize - camY); }
          ctx.stroke();
        }
      }
    }
  }

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = trailMap[y * cols + x];
      if (t === -1) continue;
      const c = players[t].color;
      ctx.fillStyle = hexAlpha(c, 0.7);
      ctx.shadowColor = c;
      ctx.shadowBlur = 8;
      const pad = Math.max(1, cellSize * 0.18);
      ctx.fillRect(x * cellSize - camX + pad, y * cellSize - camY + pad, cellSize - pad * 2, cellSize - pad * 2);
    }
  }
  ctx.shadowBlur = 0;

  // heads (interpolated)
  for (const p of players) {
    // Triple-gate: alive flag, visible flag, AND on-grid coordinates.
    // killPlayer() teleports dead entities to (-1,-1) — this final check
    // means even a stale entity slipping past the flags can't paint a head.
    if (!p.alive || !p.visible) continue;
    if (p.x < 0 || p.y < 0) continue;
    const ip = interp.get(p.id) ?? { fx: p.x, fy: p.y };
    const sx = ip.fx * cellSize - camX;
    const sy = ip.fy * cellSize - camY;
    if (sx < -cellSize * 4 || sy < -cellSize * 4 || sx > W + cellSize * 4 || sy > H + cellSize * 4) continue;
    const c = p.color;
    ctx.shadowColor = c;
    ctx.shadowBlur = 14;
    ctx.fillStyle = c;
    ctx.fillRect(sx, sy, cellSize, cellSize);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    const ipad = cellSize * 0.3;
    ctx.fillRect(sx + ipad, sy + ipad, cellSize - ipad * 2, cellSize - ipad * 2);
  }

  // absorption particles — fly from victim location toward killer (interp pos)
  for (const pt of state.particles) {
    const t = Math.min(1, pt.life / pt.maxLife);
    const ease = 1 - Math.pow(1 - t, 2); // easeOut
    const killer = players[pt.killerId];
    const kI = interp.get(pt.killerId) ?? { fx: killer?.x ?? 0, fy: killer?.y ?? 0 };
    const tx = kI.fx + 0.5;
    const ty = kI.fy + 0.5;
    const px = (pt.startX + (tx - pt.startX) * ease + pt.jitterX * (1 - t)) * cellSize - camX;
    const py = (pt.startY + (ty - pt.startY) * ease + pt.jitterY * (1 - t)) * cellSize - camY;
    const alpha = 1 - t;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = pt.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = pt.color;
    const s = pt.size;
    ctx.fillRect(px - s / 2, py - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // labels (interpolated)
  const labelSize = Math.max(11, Math.floor(cellSize * 0.95));
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const p of players) {
    if (!p.alive || !p.visible) continue;
    if (p.x < 0 || p.y < 0) continue;
    const ip = interp.get(p.id) ?? { fx: p.x, fy: p.y };
    const cx = ip.fx * cellSize - camX + cellSize / 2;
    const cy = ip.fy * cellSize - camY - 4;

    // bounty pulse: scale 1 -> 1.3 -> 1 over pulse duration; color flash to neon green.
    const pulseT = p.bountyPulseDuration > 0 ? p.bountyPulseMs / p.bountyPulseDuration : 0; // 1 -> 0
    const scale = 1 + 0.15 * pulseT;
    const bountyColor = pulseT > 0 ? mixHex("#00FF66", "#ccff66", Math.min(1, pulseT * 1.2)) : "#00FF66";
    const bountyText = state.mode === "territory"
      ? `$${p.displayTerritoryValue.toFixed(2)}`
      : `$${p.displayBounty.toFixed(2)}`;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.font = `700 ${labelSize}px "JetBrains Mono", monospace`;
    ctx.shadowColor = "#004d1a";
    ctx.shadowBlur = pulseT > 0 ? 14 : 6;
    ctx.fillStyle = bountyColor;
    ctx.fillText(bountyText, 0, 0);
    ctx.restore();
    ctx.shadowBlur = 0;

    ctx.font = `700 ${Math.max(10, labelSize - 1)}px "Orbitron", sans-serif`;
    ctx.fillStyle = p.isHuman ? "#ffffff" : "rgba(255,255,255,0.85)";
    ctx.shadowColor = p.isHuman ? "#ffffff" : "rgba(0,0,0,0.6)";
    ctx.shadowBlur = p.isHuman ? 6 : 0;
    ctx.fillText(p.name, cx, cy - labelSize - 2);
    ctx.shadowBlur = 0;
  }

  // "+1 KILL" floating combat-text popups, anchored above each killer's name.
  if (state.killPopups.length) {
    const killSize = Math.max(12, Math.floor(cellSize * 0.85));
    ctx.font = `800 ${killSize}px "Orbitron", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const k of state.killPopups) {
      const p = players[k.playerId];
      if (!p || !p.alive || !p.visible || p.x < 0 || p.y < 0) continue;
      const ip = interp.get(p.id) ?? { fx: p.x, fy: p.y };
      const cx = ip.fx * cellSize - camX + cellSize / 2;
      const baseY = ip.fy * cellSize - camY - 4 - labelSize - 2 - (labelSize + 4);
      const t = Math.min(1, k.life / k.maxLife);
      const drift = 18 * t;
      const alpha = 1 - t;
      ctx.globalAlpha = alpha;
      ctx.shadowColor = "#a6ff3a";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#a6ff3a";
      ctx.fillText("+1 KILL", cx, baseY - drift);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
}

function PodiumIcon() {
  return (
    <svg width="34" height="22" viewBox="0 0 34 22" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(244,255,58,0.6))" }}>
      <rect x="1" y="9" width="10" height="12" stroke="#f4ff3a" strokeWidth="1.8" fill="none" />
      <rect x="12" y="1" width="10" height="20" stroke="#f4ff3a" strokeWidth="1.8" fill="none" />
      <rect x="23" y="6" width="10" height="15" stroke="#f4ff3a" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

function mixHex(a: string, b: string, t: number) {
  const pa = parseHex(a), pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

function hexAlpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
