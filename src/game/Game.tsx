import { useEffect, useRef, useState } from "react";
import { updateAnimations, type Dir, type GameState } from "./engine";
import { applySnapshot, b64ToInt8, createRenderState } from "./applySnapshot";
import type { EliminationPayload, GameSnapshot, MatchEndPayload } from "./protocol";
import { playClickSound, playLoseSound, playWinSound } from "@/lib/audio";
import { Clock, Skull, Eye } from "lucide-react";
import logoAsset from "@/assets/paper-arena-logo-v2.png.asset.json";

interface Props {
  playerId: number;
  players: number;
  wager: number;
  snapshot: GameSnapshot;
  sendInput: (dir: Dir) => void;
  elimination: EliminationPayload | null;
  matchEnd: MatchEndPayload | null;
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
type Interp = { fx: number; fy: number };

function getSnapshotTerritoryCounts(snapshot: GameSnapshot, playerCount: number) {
  const territory = b64ToInt8(snapshot.territoryB64);
  const counts = new Array<number>(playerCount).fill(0);
  for (let i = 0; i < territory.length; i++) {
    const owner = territory[i];
    if (owner >= 0 && owner < playerCount) counts[owner]++;
  }
  return counts;
}

export default function Game({
  playerId,
  players,
  wager,
  snapshot,
  sendInput,
  elimination,
  matchEnd,
  onExit,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const rafRef = useRef<number | null>(null);
  const viewRef = useRef<{ w: number; h: number; camX: number; camY: number; cell: number }>({ w: 800, h: 800, camX: 0, camY: 0, cell: PLAY_CELL });
  const spectatingRef = useRef(false);
  const prevPosRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const interpRef = useRef<Map<number, Interp>>(new Map());
  const enterSpectateRef = useRef<() => void>(() => {});
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;
  const lastTickRef = useRef(-1);
  const lastSnapshotAtRef = useRef(performance.now());
  const interpAlphaRef = useRef(0);
  const territoryCountsRef = useRef<number[]>([]);

  const [, force] = useState(0);
  const [spectating, setSpectating] = useState(false);
  const [showLostModal, setShowLostModal] = useState(false);
  const [lostStats, setLostStats] = useState<{ mapPct: number; valueLost: number; kills: number; timeSurvivedMs: number; cause: "killed" | "self" } | null>(null);
  const loseSoundPlayedRef = useRef(false);
  const winSoundPlayedRef = useRef(false);

  useEffect(() => {
    if (!elimination || loseSoundPlayedRef.current) return;
    loseSoundPlayedRef.current = true;
    setLostStats({
      mapPct: elimination.mapPct,
      valueLost: elimination.valueLost,
      kills: elimination.kills,
      timeSurvivedMs: elimination.timeSurvivedMs,
      cause: elimination.cause,
    });
    setShowLostModal(true);
    playLoseSound();
  }, [elimination]);

  useEffect(() => {
    if (matchEnd?.isYou && matchEnd.netPayout > 0 && !winSoundPlayedRef.current) {
      winSoundPlayedRef.current = true;
      playWinSound();
    }
    if (matchEnd) {
      spectatingRef.current = false;
      setSpectating(false);
      setShowLostModal(false);
    }
  }, [matchEnd]);

  useEffect(() => {
    const state = createRenderState(snapshot, playerId, players, wager);
    stateRef.current = state;
    lastTickRef.current = snapshot.tick;
    lastSnapshotAtRef.current = performance.now();
    spectatingRef.current = false;
    setSpectating(false);
    setShowLostModal(false);
    loseSoundPlayedRef.current = false;
    winSoundPlayedRef.current = false;
    prevPosRef.current = new Map(state.players.map((p) => [p.id, { x: p.x, y: p.y }]));
    interpRef.current = new Map(state.players.map((p) => [p.id, { fx: p.x, fy: p.y }]));
    territoryCountsRef.current = getSnapshotTerritoryCounts(snapshot, state.players.length);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const fitSpectateCell = () => {
      const pad = 40;
      return Math.max(3, Math.floor(Math.min((viewRef.current.w - pad) / state.cols, (viewRef.current.h - pad) / state.rows)));
    };

    const resize = () => {
      const sidebarWidth = window.innerWidth >= 1024 ? 320 : 0;
      const horizontalPad = window.innerWidth >= 640 ? 32 : 16;
      const verticalReserve = window.innerWidth >= 1024 ? 100 : 360;
      const w = Math.max(280, Math.min(window.innerWidth - sidebarWidth - horizontalPad, 1200));
      const h = Math.max(360, window.innerHeight - verticalReserve);
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
        const me = state.players[playerId];
        if (me) {
          viewRef.current.cell = PLAY_CELL;
          state.cellSize = PLAY_CELL;
          viewRef.current.camX = me.x * PLAY_CELL - w / 2;
          viewRef.current.camY = me.y * PLAY_CELL - h / 2;
        }
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const onKey = (e: KeyboardEvent) => {
      if (spectatingRef.current) return;
      const d = KEY_MAP[e.key];
      if (!d) return;
      e.preventDefault();
      sendInputRef.current(d);
    };
    window.addEventListener("keydown", onKey);

    const startedAt = performance.now();
    let last = startedAt;
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
      hudAcc += dt;

      const snap = snapshotRef.current;
      if (snap.tick > lastTickRef.current) {
        for (const p of state.players) {
          prevPosRef.current.set(p.id, { x: p.x, y: p.y });
        }
        applySnapshot(state, snap, playerId);
        territoryCountsRef.current = getSnapshotTerritoryCounts(snap, state.players.length);
        lastTickRef.current = snap.tick;
        lastSnapshotAtRef.current = now;
        interpAlphaRef.current = 0;
      } else {
        interpAlphaRef.current = Math.min(1, (now - lastSnapshotAtRef.current) / snap.tickMs);
      }

      updateAnimations(state, dt, territoryCountsRef.current);

      const alpha = interpAlphaRef.current;
      for (const p of state.players) {
        const prev = prevPosRef.current.get(p.id) ?? { x: p.x, y: p.y };
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const adjacent = Math.abs(dx) + Math.abs(dy) === 1;
        const fx = adjacent ? prev.x + dx * alpha : p.x;
        const fy = adjacent ? prev.y + dy * alpha : p.y;
        interpRef.current.set(p.id, { fx, fy });
      }

      const cell = viewRef.current.cell;
      if (spectatingRef.current) {
        const tx = (state.cols * cell - viewRef.current.w) / 2;
        const ty = (state.rows * cell - viewRef.current.h) / 2;
        viewRef.current.camX += (tx - viewRef.current.camX) * 0.12;
        viewRef.current.camY += (ty - viewRef.current.camY) * 0.12;
      } else {
        const me = state.players[playerId];
        if (me) {
          const meI = interpRef.current.get(me.id) ?? { fx: me.x, fy: me.y };
          const targetX = meI.fx * cell - viewRef.current.w / 2;
          const targetY = meI.fy * cell - viewRef.current.h / 2;
          viewRef.current.camX += (targetX - viewRef.current.camX) * 0.2;
          viewRef.current.camY += (targetY - viewRef.current.camY) * 0.2;
        }
      }

      render(ctx, state, viewRef.current, interpRef.current);

      if (hudAcc > 200) {
        hudAcc = 0;
        force((v) => v + 1);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
    };
  }, [playerId, players, wager]);

  const state = stateRef.current;
  const me = state?.players[playerId];
  const alivePlayers = state ? state.players.filter((p) => p.alive) : [];
  const isTerritory = state?.mode === "territory";
  const territoryCounts = state ? territoryCountsRef.current : [];
  const totalCells = state ? state.cols * state.rows : 1;
  const valueFor = (id: number) => (state ? (territoryCounts[id] / totalCells) * state.totalMapValue : 0);
  const pctFor = (id: number) => (state ? (territoryCounts[id] / totalCells) * 100 : 0);
  const sorted = state
    ? [...state.players].sort((a, b) => (isTerritory ? valueFor(b.id) - valueFor(a.id) : b.bounty - a.bounty))
    : [];
  const myPct = state ? pctFor(playerId) : 0;
  const timeMs = state?.timeRemainingMs ?? 0;
  const timeStr = `${String(Math.floor(timeMs / 60000)).padStart(2, "0")}:${String(Math.floor((timeMs % 60000) / 1000)).padStart(2, "0")}`;
  const showSpectate =
    showLostModal &&
    !matchEnd &&
    snapshot.timeRemainingMs > 0 &&
    snapshot.survivors > 0;
  const exitPayout = matchEnd?.netPayout ?? 0;
  const exitWon = matchEnd?.isYou === true && exitPayout > 0;

  return (
    <div className="min-h-screen w-full flex flex-col lg:flex-row" style={{ background: "#0a0b0d" }}>
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative min-w-0">
        <canvas ref={canvasRef} className="block max-h-[calc(100vh-1rem)] max-w-full rounded-md neon-border sm:max-h-[calc(100vh-2rem)]" />

        {isTerritory && !matchEnd && (
          <div className="absolute top-3 sm:top-6 left-1/2 -translate-x-1/2 px-3 sm:px-6 py-2 rounded-md border backdrop-blur-md flex items-center gap-2 sm:gap-3" style={{ background: "rgba(10,11,13,0.6)", borderColor: timeMs < 30000 ? "#ff3a6b" : "#f4ff3a", boxShadow: `0 0 24px ${timeMs < 30000 ? "rgba(255,58,107,0.5)" : "rgba(244,255,58,0.35)"}` }}>
            <span className="font-display text-[9px] sm:text-[10px] tracking-[0.22em] sm:tracking-[0.35em] text-white/70">TIME</span>
            <span className="font-display text-2xl sm:text-3xl tabular-nums" style={{ color: timeMs < 30000 ? "#ff3a6b" : "#f4ff3a", textShadow: `0 0 14px ${timeMs < 30000 ? "#ff3a6b" : "#f4ff3a"}` }}>{timeStr}</span>
          </div>
        )}

        {spectating && !matchEnd && (
          <>
            <div className="absolute top-3 sm:top-6 left-3 sm:left-6 flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 backdrop-blur-md" style={{ background: "rgba(10,11,13,0.55)" }}>
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "#ff3a6b", boxShadow: "0 0 10px #ff3a6b" }} />
              <span className="font-display text-[11px] tracking-[0.35em] text-white/90">SPECTATING LIVE</span>
            </div>
            <div className="absolute bottom-4 sm:bottom-8 left-1/2 -translate-x-1/2">
              <button
                onClick={() => { playClickSound(); onExit({ won: false, payout: 0 }); }}
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

        {showLostModal && !matchEnd && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-md z-30 p-3 sm:p-6">
            <div
              className="w-full max-w-[min(92vw,420px)] overflow-hidden rounded-lg border px-4 py-7 sm:px-8 sm:py-9"
              style={{
                background: "#0a0b0d",
                borderColor: "rgba(244,255,58,0.55)",
                filter: "drop-shadow(0 0 28px rgba(244,255,58,0.55)) drop-shadow(0 0 70px rgba(244,255,58,0.35))",
              }}
            >
              <div className="text-center">
                <div
                  className="font-display mb-3"
                  style={{ color: "#ff2a3d", textShadow: "0 0 18px rgba(255,42,61,0.85), 0 0 42px rgba(255,42,61,0.55)", letterSpacing: "0.06em", fontSize: "clamp(2.35rem, 13vw, 3.75rem)", lineHeight: 0.95 }}
                >
                  YOU LOST
                </div>
                <div className="font-display text-[11px] md:text-sm tracking-[0.18em] md:tracking-[0.35em] text-white mb-8">
                  {lostStats?.cause === 'killed' ? "YOU GOT KILLED" : "YOU KILLED YOURSELF"}
                </div>
              </div>

              <div
                className="rounded-lg px-4 py-4 sm:px-5 sm:py-5"
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
                  value={String(lostStats?.kills ?? me?.kills ?? 0)}
                />
                <StatRow
                  label="MAP % LOST"
                  value={`${(lostStats?.mapPct ?? myPct).toFixed(0)}%`}
                />
                <StatRow
                  label="MAP VALUE LOST"
                  value={`$${(lostStats?.valueLost ?? 0).toFixed(2)}`}
                  valueColor="#ff2a3d"
                  valueShadow="0 0 14px rgba(255,42,61,0.6)"
                  last
                />
              </div>

              <div className="flex flex-col min-[420px]:flex-row gap-3 mt-7 justify-center">
                {showSpectate && (
                  <button
                    onClick={() => { playClickSound(); setShowLostModal(false); enterSpectateRef.current(); }}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md border px-5 py-3 font-display text-[11px] tracking-[0.14em] transition hover:scale-[1.03] sm:tracking-[0.25em]"
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
                  onClick={() => { playClickSound(); onExit({ won: false, payout: 0 }); }}
                  className="flex-1 rounded-md border px-5 py-3 font-display text-[11px] tracking-[0.14em] transition hover:scale-[1.03] sm:tracking-[0.25em]"
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

        {matchEnd?.houseClaim && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-md">
            <div
              className="w-[92%] max-w-lg rounded-lg border p-5 text-center sm:p-8"
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
              <div className="font-display text-5xl mb-2 text-white/30 line-through tabular-nums">${state?.totalMapValue.toFixed(2) ?? "0.00"}</div>
              <div className="text-[11px] tracking-[0.35em] text-white/50 mb-6">FORFEITED TO PLATFORM</div>
              <button onClick={() => { playClickSound(); onExit({ won: false, payout: 0 }); }} className="mt-2 rounded-md px-8 py-3 font-display text-sm tracking-widest neon-border hover:bg-white/5">
                RETURN TO LOBBY
              </button>
            </div>
          </div>
        )}

        {matchEnd && !matchEnd.houseClaim && !(showLostModal && !spectating) && (() => {
          const isHumanWin = matchEnd.isYou && matchEnd.netPayout > 0;
          const ultra = matchEnd.ultra && isHumanWin;
          const winnerColor = me?.color ?? "#f4ff3a";
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-md p-3 sm:p-6">
              <div
                className="w-full max-w-[min(92vw,460px)] overflow-hidden rounded-lg border px-4 py-7 sm:px-8 sm:py-9"
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
                    className="font-display mb-3 max-w-full px-1"
                    style={{
                      color: isHumanWin ? "#f4ff3a" : winnerColor,
                      textShadow: `0 0 18px ${isHumanWin ? "rgba(244,255,58,0.85)" : winnerColor}, 0 0 42px ${isHumanWin ? "rgba(244,255,58,0.55)" : "rgba(255,255,255,0.2)"}`,
                      fontSize: "clamp(2.25rem, 10vw, 3.75rem)",
                      lineHeight: 0.95,
                      letterSpacing: "0.04em",
                      overflowWrap: "anywhere",
                      wordBreak: "normal",
                    }}
                  >
                    {isHumanWin ? "VICTORY" : `${matchEnd.winnerName} WINS`}
                  </div>
                  <div className="font-display text-[11px] md:text-sm tracking-[0.22em] md:tracking-[0.3em] text-white mb-8 px-1">
                    {isHumanWin
                      ? (ultra
                          ? <>YOU CONQUERED <span style={{ color: "#f4ff3a", textShadow: "0 0 10px rgba(244,255,58,0.7)" }}>100%</span> OF MAP</>
                          : "YOU SURVIVED THE TIMER")
                      : "MATCH COMPLETE"}
                  </div>
                </div>

                <div
                  className="rounded-lg px-4 py-4 sm:px-5 sm:py-5"
                  style={{ background: "#06070a", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <StatRow
                    label="TIME SURVIVED"
                    icon={<Clock className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                    value={formatClock(matchEnd.timeSurvivedMs)}
                  />
                  <StatRow
                    label="KILLS"
                    icon={<Skull className="w-3.5 h-3.5 text-white/80" strokeWidth={2.2} />}
                    value={String(matchEnd.kills)}
                  />
                  <StatRow
                    label="MAP % CONQUERED"
                    value={`${Math.round(matchEnd.mapPct)}%`}
                    valueColor={ultra ? "#f4ff3a" : undefined}
                    valueShadow={ultra ? "0 0 12px rgba(244,255,58,0.7)" : undefined}
                  />
                  <StatRow
                    label="MAP VALUE WON"
                    value={`$${matchEnd.mapValue.toFixed(2)}`}
                  />
                  <StatRow
                    twoLine={["YOUR PRIZE", "- PLATFORM FEE (2%)"]}
                    value={`$${matchEnd.netPayout.toFixed(2)}`}
                    valueColor="#f4ff3a"
                    valueShadow="0 0 14px rgba(244,255,58,0.7)"
                    last
                  />
                </div>

                <div className="flex justify-center mt-7">
                  <button
                    onClick={() => { playClickSound(); onExit({ won: exitWon, payout: exitPayout }); }}
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

      <aside className="w-full lg:w-[320px] lg:h-screen border-t lg:border-t-0 lg:border-l border-border/50 p-3 sm:p-5 flex flex-col gap-4 lg:gap-5 overflow-visible lg:overflow-hidden" style={{ background: "#0c0d10" }}>
        <div className="hidden lg:flex flex-col items-center text-center">
          <img src={logoAsset.url} alt="PaperArena" className="w-full h-auto object-contain" />
          <div className="font-display text-[10px] tracking-[0.35em] text-white/60 mt-1">{"\n"}</div>
        </div>
        <div className="text-center font-display tracking-[0.18em] lg:tracking-[0.35em] text-white text-sm lg:text-base uppercase break-words">
          {arenaLabel(players)}
        </div>
        <div
          className="rounded-2xl px-3 sm:px-4 py-3 grid grid-cols-3 gap-2"
          style={{
            background: "linear-gradient(180deg, rgba(20,22,26,0.95) 0%, rgba(14,15,18,0.95) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02), 0 6px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div className="flex flex-col items-start">
            <div className="font-display text-[8px] sm:text-[9px] tracking-[0.12em] sm:tracking-[0.2em] text-white/70">MAP VALUE</div>
            <div className="font-mono font-bold text-base mt-1 tabular-nums" style={{ color: "#f4ff3a", textShadow: "0 0 10px rgba(244,255,58,0.6)" }}>
              ${state?.totalPot.toFixed(2) ?? "0.00"}
            </div>
          </div>
          <div className="flex flex-col items-center border-x border-white/10">
            <div className="font-display text-[8px] sm:text-[9px] tracking-[0.12em] sm:tracking-[0.2em] text-white/70">WAGER</div>
            <div className="font-mono font-bold text-base mt-1 text-white tabular-nums">${wager.toFixed(2)}</div>
          </div>
          <div className="flex flex-col items-end">
            <div className="font-display text-[8px] sm:text-[9px] tracking-[0.12em] sm:tracking-[0.2em] text-white/70">PLAYERS ALIVE</div>
            <div className="font-mono font-bold text-base mt-1 text-white tabular-nums">{snapshot.survivors}/{players}</div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-1">
          <div className="font-display text-[12px] tracking-[0.18em] text-white">LIVE ARENA LEADERBOARD</div>
          <PodiumIcon />
        </div>
        <div className="lg:flex-1 max-h-[42vh] lg:max-h-none overflow-auto space-y-2 pr-1">
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
    <div className={`flex items-center justify-between gap-3 py-3 ${last ? "" : "border-b border-white/[0.06]"}`}>
      <div className="flex items-center gap-2 min-w-0">
        {twoLine ? (
          <div className="flex flex-col leading-tight min-w-0">
            <span className="font-display text-[10px] tracking-[0.18em] sm:tracking-[0.25em] text-white truncate">{twoLine[0]}</span>
            <span className="font-display text-[9px] tracking-[0.14em] sm:tracking-[0.22em] text-white/55 mt-0.5 truncate">{twoLine[1]}</span>
          </div>
        ) : (
          <span className="font-display text-[10px] tracking-[0.16em] sm:tracking-[0.25em] text-white truncate">{label}</span>
        )}
        {icon}
      </div>
      <span
        className="font-display text-base tabular-nums shrink-0"
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

  for (const p of players) {
    ctx.fillStyle = hexAlpha(p.color, 0.22);
    ctx.beginPath();
    for (let y = y0; y < y1; y++) {
      const row = y * cols;
      for (let x = x0; x < x1; x++) {
        if (territory[row + x] === p.id) {
          ctx.rect(x * cellSize - camX, y * cellSize - camY, cellSize, cellSize);
        }
      }
    }
    ctx.fill();
  }

  ctx.lineWidth = 1;
  for (const p of players) {
    ctx.strokeStyle = hexAlpha(p.color, 0.6);
    ctx.beginPath();
    for (let y = y0; y < y1; y++) {
      const row = y * cols;
      for (let x = x0; x < x1; x++) {
        if (territory[row + x] !== p.id) continue;
        const sx = x * cellSize - camX;
        const sy = y * cellSize - camY;
        if (x + 1 >= cols || territory[row + x + 1] !== p.id) {
          ctx.moveTo(sx + cellSize, sy);
          ctx.lineTo(sx + cellSize, sy + cellSize);
        }
        if (x - 1 < 0 || territory[row + x - 1] !== p.id) {
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx, sy + cellSize);
        }
        if (y + 1 >= rows || territory[row + cols + x] !== p.id) {
          ctx.moveTo(sx, sy + cellSize);
          ctx.lineTo(sx + cellSize, sy + cellSize);
        }
        if (y - 1 < 0 || territory[row - cols + x] !== p.id) {
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + cellSize, sy);
        }
      }
    }
    ctx.stroke();
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
