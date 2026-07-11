import { createFileRoute, Link } from "@tanstack/react-router";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useRef, useState } from "react";
import Game from "@/game/Game";
import { useGameSocket } from "@/game/useGameSocket";
import { useWallet, formatUSD, formatNativeBalance } from "@/lib/wallet";
import { playClickSound, playWinSound, installAudioUnlock } from "@/lib/audio";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PaperArena — Skill-Based Betting Arena" },
      { name: "description", content: "PaperArena is a skill-based multiplayer territory game. Wager, capture, eliminate — last player claims the pot." },
      { property: "og:title", content: "PaperArena — Skill-Based Betting" },
      { property: "og:description", content: "Capture territory, eliminate rivals, claim the pot in PaperArena's neon-lit grid duels." },
    ],
  }),
  component: Index,
});

const PLAYER_OPTIONS = [
  { n: 5, display: "STANDARD ARENA", label: "5 PLAYERS\n2,5 MIN MATCH" },
  { n: 10, display: "MEGA ARENA", label: "10 PLAYERS\n5 MIN MATCH" },
];
const WAGER_OPTIONS = [5, 10, 20];
const PLATFORM_FEE = Number(import.meta.env.VITE_PLATFORM_FEE);
const DEV_MATCH_ENTRY = import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_MATCH_ENTRY === "true";
const DEV_STANDARD_ARENA_PLAYERS = Number(import.meta.env.VITE_DEV_STANDARD_ARENA_PLAYERS);

if (!Number.isFinite(PLATFORM_FEE)) {
  throw new Error("VITE_PLATFORM_FEE is required.");
}

if (DEV_MATCH_ENTRY && (!Number.isInteger(DEV_STANDARD_ARENA_PLAYERS) || DEV_STANDARD_ARENA_PLAYERS <= 0)) {
  throw new Error("VITE_DEV_STANDARD_ARENA_PLAYERS is required when dev match entry is enabled.");
}


const SKIN_COLORS = [
  "#f4ff3a", "#3afff0", "#ff3af0", "#3aff7a",
  "#ff7a3a", "#7a3aff", "#ff3a6b", "#3a8cff",
];

const FAKE_LEADERBOARD = [
  { name: "domipiqka", amount: 11200.03 },
  { name: "MarketingMachine", amount: 10936.79 },
  { name: "glx_duolingo", amount: 10818.86 },
];

type LobbyPhase = "idle" | "queueing" | "in_match";

function Index() {
  const wallet = useWallet();
  const socket = useGameSocket();
  const [players, setPlayers] = useState(5);
  const [wager, setWager] = useState(10);
  const mode = "territory" as const;
  const [phase, setPhase] = useState<LobbyPhase>("idle");
  const [username, setUsername] = useState("PLAYER");
  const [skin, setSkin] = useState(SKIN_COLORS[0]);
  const [evmSignPending, setEvmSignPending] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);
  const joinPendingRef = useRef(false);
  const wagerDeductedRef = useRef(false);

  useEffect(() => { installAudioUnlock(); }, []);

  useEffect(() => {
    setUsername(`PLAYER_${Math.floor(1000 + Math.random() * 9000)}`);
  }, []);

  useEffect(() => {
    if (!evmSignPending || wallet.connected || !wallet.evmWalletReady) return;
    let cancelled = false;
    setWalletActionError(null);
    wallet
      .signInEvm()
      .then(() => {
        if (!cancelled) setEvmSignPending(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setWalletActionError(err instanceof Error ? err.message : "Could not sign in with that wallet.");
          setEvmSignPending(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [evmSignPending, wallet.connected, wallet.evmWalletReady, wallet.signInEvm]);

  useEffect(() => {
    if (socket.matchId && socket.playerId != null && socket.snapshot) {
      setPhase("in_match");
    }
  }, [socket.matchId, socket.playerId, socket.snapshot]);

  useEffect(() => {
    if (!socket.error || phase !== "queueing") return;
    joinPendingRef.current = false;
    if (wagerDeductedRef.current) {
      wallet.credit(wager);
      wagerDeductedRef.current = false;
    }
    setPhase("idle");
  }, [phase, socket.error, wager, wallet]);

  const totalPot = players * wager;
  const fee = totalPot * PLATFORM_FEE;
  const prize = totalPot - fee;
  const isQueueing = phase === "queueing";
  const arena = players === 5 ? "standard" as const : "mega" as const;
  const expectedQueueNeeded =
    socket.queueNeeded ??
    (DEV_MATCH_ENTRY && arena === "standard" ? DEV_STANDARD_ARENA_PLAYERS : players);
  const walletLabel = wallet.primaryWallet
    ? `${wallet.primaryWallet.address.slice(0, 4)}...${wallet.primaryWallet.address.slice(-4)}`
    : "CONNECT WALLET";

  const handleCopyWallet = async () => {
    playClickSound();
    if (!wallet.primaryWallet) return;
    try {
      await navigator.clipboard.writeText(wallet.primaryWallet.address);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : "Could not copy wallet address.");
    }
  };

  const handleRefreshWallet = async () => {
    playClickSound();
    setWalletActionError(null);
    await wallet.refresh();
  };

  const handleJoin = async () => {
    playClickSound();
    if (!wallet.connected) {
      setWalletActionError(null);
      setEvmSignPending(true);
      wallet.openEvmPicker();
      return;
    }
    if (isQueueing) return;
    joinPendingRef.current = true;
    setPhase("queueing");
    socket.connect();
    try {
      await socket.waitForAuth();
      if (joinPendingRef.current) {
        socket.joinQueue(arena, wager, username || "PLAYER", skin);
      }
    } catch {
      if (wagerDeductedRef.current) {
        wallet.credit(wager);
        wagerDeductedRef.current = false;
      }
      joinPendingRef.current = false;
      setPhase("idle");
    }
  };

  const handleCancelQueue = () => {
    playClickSound();
    joinPendingRef.current = false;
    socket.leaveQueue();
    if (wagerDeductedRef.current) {
      wallet.credit(wager);
      wagerDeductedRef.current = false;
    }
    setPhase("idle");
  };

  const handleGameEnd = (result: { won: boolean; payout?: number }) => {
    joinPendingRef.current = false;
    wagerDeductedRef.current = false;
    if (mode === "territory") {
      const p = result.payout ?? 0;
      if (p > 0) {
        wallet.credit(p);
        if (result.won) playWinSound();
      }
    } else if (result.won) {
      wallet.credit(result.payout ?? prize);
      playWinSound();
    }
    socket.reset();
    socket.disconnect();
    setPhase("idle");
  };

  if (phase === "in_match" && socket.snapshot && socket.playerId != null) {
    return (
      <Game
        playerId={socket.playerId}
        players={players}
        wager={wager}
        snapshot={socket.snapshot}
        sendInput={socket.sendInput}
        elimination={socket.elimination}
        matchEnd={socket.matchEnd}
        onExit={handleGameEnd}
      />
    );
  }

  return (
    <main className="min-h-screen w-full grid-bg-sharp" style={{ background: "#0a0b0d" }}>
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <span className="font-display text-xl tracking-widest text-white">Welcome, <span style={{ color: "#f4ff3a" }}>{username || "PLAYER"}</span></span>
          <div className="flex items-center gap-3">
            <Link
              to="/guide"
              onClick={() => playClickSound()}
              className="flex items-center gap-2 font-display text-xs tracking-[0.25em] px-4 py-3 rounded border border-white/10 hover:border-[#f4ff3a]/50 hover:bg-[#f4ff3a]/5 text-white/80 hover:text-[#f4ff3a] transition"
            >
              <HelpIcon /> HOW TO PLAY
            </Link>
            <ConnectButton.Custom>
              {({ account, chain, mounted, openConnectModal }) => {
                const evmSelected = mounted && account && chain;
                const label = wallet.connected
                  ? walletLabel
                  : evmSelected
                    ? evmSignPending
                      ? "SIGNING..."
                      : "SIGN TO LOGIN"
                    : "CONNECT WALLET";

                return (
                  <button
                    onClick={async () => {
                      playClickSound();
                      setWalletActionError(null);
                      try {
                        if (wallet.connected) {
                          setEvmSignPending(false);
                          await wallet.signOut();
                          return;
                        }
                        setEvmSignPending(true);
                        if (evmSelected) return;
                        openConnectModal?.();
                      } catch (err) {
                        setWalletActionError(err instanceof Error ? err.message : "Wallet action failed.");
                        setEvmSignPending(false);
                      }
                    }}
                    className="font-display text-xs tracking-[0.3em] px-5 py-3 neon-border rounded hover:bg-white/5 transition"
                  >
                    {label}
                  </button>
                );
              }}
            </ConnectButton.Custom>
          </div>
        </header>

        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="font-display font-black text-6xl md:text-7xl tracking-tighter">
            <span className="text-white" style={{ textShadow: "0 0 20px rgba(255,255,255,0.3)" }}>PAPER</span>
            <span style={{ color: "#f4ff3a", textShadow: "0 0 20px rgba(244,255,58,0.6)" }}>ARENA</span>
          </h1>
          <div className="font-display tracking-[0.5em] text-sm text-white/70 mt-2">{"\n"}</div>
        </div>

        {/* Grid: 3 cols */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_2.25fr_1fr] gap-5">
          {/* LEFT: Leaderboard */}
          <Widget>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <TrophyIcon />
                <span className="font-display text-xl text-white tracking-wide">Leaderboard</span>
              </div>
              <span className="flex items-center gap-1.5 text-xs font-display tracking-wider px-2.5 py-1 rounded-full" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.4)" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Live
              </span>
            </div>
            <div className="space-y-3 mb-5">
              {FAKE_LEADERBOARD.map((row, i) => (
                <div key={row.name} className="flex items-center justify-between">
                  <span className="text-white text-base font-medium">
                    <span className="text-white/50 mr-2">{i + 1}.</span>{row.name}
                  </span>
                  <span className="font-mono font-bold text-base" style={{ color: "#f4ff3a" }}>
                    ${row.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
            <button onClick={playClickSound} className="w-full py-3 rounded-lg border border-white/15 hover:border-white/40 hover:bg-white/5 text-white font-display tracking-wider text-sm transition">
              View Full Leaderboard
            </button>
          </Widget>

          {/* CENTER: Matchmaking */}
          <Widget>
            <div className="text-center mb-5">
              <div className="font-display text-xs tracking-[0.4em] text-white/50">CONFIGURE MATCH</div>
            </div>


            <Section label="ARENA SIZE">
              <div className="grid grid-cols-2 gap-2">
                {PLAYER_OPTIONS.map(opt => (
                  <button
                    key={opt.n}
                    onClick={() => { if (!isQueueing) { playClickSound(); setPlayers(opt.n); } }}
                    disabled={isQueueing}
                    className={`py-4 px-2 rounded-lg transition border-2 ${
                      players === opt.n
                        ? "border-[#f4ff3a] bg-[#f4ff3a]/10"
                        : "border-white/10 hover:border-white/30"
                    } ${isQueueing ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <div className={`font-display font-black whitespace-nowrap text-lg ${players === opt.n ? "text-[#f4ff3a]" : "text-white"}`}>{opt.display}</div>
                    <div className="text-[10px] tracking-widest text-white/60 font-display mt-1 whitespace-pre-line">{opt.label}</div>
                  </button>
                ))}
              </div>
            </Section>

            <Section label="WAGER">
              <div className="grid grid-cols-3 gap-2">
                {WAGER_OPTIONS.map(w => (
                  <button
                    key={w}
                    onClick={() => { if (!isQueueing) { playClickSound(); setWager(w); } }}
                    disabled={isQueueing}
                    className={`py-4 rounded-lg font-display text-2xl font-black transition ${
                      wager === w
                        ? "text-[#0a0b0d]"
                        : "text-white bg-white/5 border-2 border-white/10 hover:border-white/30"
                    } ${isQueueing ? "opacity-50 cursor-not-allowed" : ""}`}
                    style={wager === w ? { background: "#f4ff3a", boxShadow: "0 0 20px rgba(244,255,58,0.45)" } : undefined}
                  >
                    ${w}
                  </button>
                ))}
              </div>
            </Section>

            <Section label="MAP VALUE BREAKDOWN">
              <div className="rounded-lg p-4" style={{ background: "rgba(255,255,255,0.03)" }}>
                <div className="space-y-2">
                  <Row label="Players" value={String(players)} />
                  <Row label="Wager / player" value={`$${wager.toFixed(2)}`} />
                </div>
                <div className="h-px bg-white/10 my-3" />
                <div className="flex items-baseline justify-between">
                  <span className="text-xs tracking-[0.3em] font-display text-white/70">TOTAL MAP VALUE</span>
                  <span className="font-display text-4xl font-black tabular-nums" style={{ color: "#f4ff3a", textShadow: "0 0 16px rgba(244,255,58,0.6)" }}>${totalPot.toFixed(2)}</span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-xs tracking-wider font-display text-white/60">Platform Fee ({(PLATFORM_FEE * 100).toFixed(0)}%)</span>
                  <span className="font-mono text-base font-semibold text-white/60 tabular-nums">−${fee.toFixed(2)}</span>
                </div>
                <div className="text-[10px] text-white/50 font-display tracking-wider pt-3">Fee deducted from survivor payouts at cash-out.</div>
              </div>
            </Section>

            {socket.error && (
              <div className="mt-4 px-4 py-3 rounded-lg text-center text-sm font-display tracking-wider" style={{ background: "rgba(255,58,107,0.12)", color: "#ff3a6b", border: "1px solid rgba(255,58,107,0.35)" }}>
                {socket.error}
              </div>
            )}

            {wallet.error && (
              <div className="mt-4 px-4 py-3 rounded-lg text-center text-sm font-display tracking-wider" style={{ background: "rgba(255,58,107,0.12)", color: "#ff3a6b", border: "1px solid rgba(255,58,107,0.35)" }}>
                {wallet.error}
              </div>
            )}

            {walletActionError && (
              <div className="mt-4 px-4 py-3 rounded-lg text-center text-sm font-display tracking-wider" style={{ background: "rgba(255,58,107,0.12)", color: "#ff3a6b", border: "1px solid rgba(255,58,107,0.35)" }}>
                {walletActionError}
              </div>
            )}

            {isQueueing ? (
              <div className="mt-5 rounded-xl p-6 text-center border border-[#f4ff3a]/40" style={{ background: "rgba(244,255,58,0.06)" }}>
                <div className="flex items-center justify-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "#f4ff3a", boxShadow: "0 0 10px #f4ff3a" }} />
                  <span className="font-display text-xs tracking-[0.35em] text-[#f4ff3a]">SEARCHING FOR OPPONENTS</span>
                </div>
                <div className="font-display text-2xl font-black text-white tracking-wider mb-1">
                  FINDING PLAYERS… {socket.queuePosition ?? 1}/{expectedQueueNeeded}
                </div>
                <div className="text-[11px] text-white/50 font-display tracking-wider mb-5">
                  {socket.connected ? "Connected to arena server" : "Connecting to arena server…"}
                </div>
                <button
                  onClick={handleCancelQueue}
                  className="w-full py-4 rounded-xl font-display font-bold tracking-[0.25em] text-sm text-white border border-white/20 hover:border-white/40 hover:bg-white/5 transition"
                >
                  CANCEL MATCHMAKING
                </button>
              </div>
            ) : (
              <>
            <button
              onClick={handleJoin}
              disabled={isQueueing}
              className="mt-5 w-full py-5 rounded-xl font-display font-black tracking-[0.25em] text-lg text-[#0a0b0d] transition active:translate-y-0.5 disabled:cursor-not-allowed"
              style={{
                background: "linear-gradient(180deg, #fff96a 0%, #f4ff3a 50%, #d4dd1f 100%)",
                boxShadow: "0 0 30px rgba(244,255,58,0.5), 0 6px 0 rgba(120,130,10,0.6), inset 0 1px 0 rgba(255,255,255,0.6)",
              }}
            >
              {!wallet.connected
                ? "CONNECT WALLET TO JOIN"
                : "▶ JOIN GAME"}
            </button>
            <div className="mt-3 text-[11px] text-center font-display tracking-wider text-white/50">
              {!wallet.connected
                ? "Connect your wallet to enter the arena"
                : DEV_MATCH_ENTRY
                  ? "Local playtest mode. Deposits and payouts are not active."
                  : (mode === "territory" ? "Conquer as much territory as possible and earn its value" : "NO TIME LIMIT · LAST PLAYER STANDING WINS")}
            </div>
              </>
            )}
          </Widget>

          {/* RIGHT: Wallet (top) + Customize (bottom) */}
          <div className="flex flex-col gap-5">
            <Widget>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <WalletIcon />
                  <span className="font-display text-xl text-white tracking-wide">Wallet</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-white/60">
                  <button
                    onClick={handleCopyWallet}
                    disabled={!wallet.primaryWallet}
                    className="hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {walletCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={handleRefreshWallet}
                    disabled={!wallet.connected || wallet.balanceLoading}
                    className="hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {wallet.balanceLoading ? "Refreshing" : "Refresh"}
                  </button>
                </div>
              </div>
              <div className="text-center py-4">
                <div className="font-display font-black text-5xl" style={{ color: "#f4ff3a", textShadow: "0 0 16px rgba(244,255,58,0.5)" }}>{formatNativeBalance(wallet.nativeBalance, wallet.nativeBalanceSymbol)}</div>
                <div className="text-white/60 font-mono text-sm mt-1">{wallet.primaryWallet ? walletLabel : "Wallet not connected"}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <button
                  onClick={playClickSound}
                  className="py-3 rounded-lg font-display font-bold tracking-wider text-sm text-white transition active:translate-y-0.5"
                  style={{
                    background: "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)",
                    boxShadow: "0 4px 0 #14532d, inset 0 1px 0 rgba(255,255,255,0.3), 0 0 12px rgba(34,197,94,0.3)",
                  }}
                >
                  Add Funds
                </button>
                <button
                  onClick={playClickSound}
                  className="py-3 rounded-lg font-display font-bold tracking-wider text-sm text-white transition active:translate-y-0.5"
                  style={{
                    background: "linear-gradient(180deg, #818cf8 0%, #4f46e5 100%)",
                    boxShadow: "0 4px 0 #1e1b4b, inset 0 1px 0 rgba(255,255,255,0.3), 0 0 12px rgba(99,102,241,0.3)",
                  }}
                >
                  Cash Out
                </button>
              </div>
            </Widget>

            <Widget>
              <div className="flex items-center gap-2 mb-4">
                <CustomizeIcon />
                <span className="font-display text-xl text-white tracking-wide">Customize</span>
              </div>

              <label className="text-[10px] tracking-[0.3em] text-white/60 font-display">USERNAME</label>
              <input
                value={username}
                onChange={e => setUsername(e.target.value.slice(0, 16).toUpperCase())}
                maxLength={16}
                className="w-full mt-1 mb-4 px-4 py-3 rounded-lg bg-white/5 border-2 border-white/10 focus:border-[#f4ff3a]/60 focus:outline-none text-white font-display tracking-widest text-lg"
              />

              <label className="text-[10px] tracking-[0.3em] text-white/60 font-display">SKIN COLOR</label>
              <div className="flex gap-2 mt-2 mb-4">
                {SKIN_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => { playClickSound(); setSkin(c); }}
                    className={`w-9 h-9 rounded-md transition ${skin === c ? "ring-2 ring-white scale-110" : "ring-1 ring-white/20"}`}
                    style={{ background: c, boxShadow: `0 0 12px ${c}80` }}
                    aria-label={`color ${c}`}
                  />
                ))}
              </div>

              <SkinPreview color={skin} username={username || "PLAYER"} />
            </Widget>
          </div>
        </section>

        <footer className="mt-12 text-center text-[10px] tracking-[0.4em] text-white/40 font-display">
          PAPERARENA · SKILL-BASED BETTING · MVP
        </footer>
      </div>
    </main>
  );
}

function Widget({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-5 border border-white/10"
      style={{
        background: "linear-gradient(180deg, rgba(20,22,26,0.95) 0%, rgba(14,15,18,0.95) 100%)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {children}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] tracking-[0.4em] text-white/60 font-display mb-2">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm text-white/70">{label}</span>
      <span className={`font-mono text-base font-semibold ${muted ? "text-white/50" : "text-white"}`}>{value}</span>
    </div>
  );
}

function TrophyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 3px rgba(244,255,58,0.6))", display: "block" }}>
      <path d="M6 4h12M6 4v2c0 2.5 1.5 4.5 4 5.5V16h4v-4.5c2.5-1 4-3 4-5.5V4M8 16h8M10 16v3H8v3h8v-3h-2v-3" stroke="#f4ff3a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 4c0 3 2.5 5 5 5s5-2 5-5" stroke="#f4ff3a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function WalletIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 3px rgba(0,255,102,0.5))", display: "block" }}>
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="#00FF66" strokeWidth="1.8" fill="none" />
      <path d="M2 10h20" stroke="#00FF66" strokeWidth="1" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2" stroke="#00FF66" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
function CustomizeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 3px rgba(58,255,240,0.5))", display: "block" }}>
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="#3afff0" strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="9.5" r="3" stroke="#3afff0" strokeWidth="1.5" fill="none" />
      <path d="M7 17.5c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#3afff0" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function SkinPreview({ color, username }: { color: string; username: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    const cell = 12;
    const cols = Math.floor(W / cell);
    const rows = Math.floor(H / cell);

    let x = 2, y = Math.floor(rows / 2);
    let dir: [number, number] = [1, 0];
    const trail: Array<{ x: number; y: number }> = [];
    let frame = 0;
    let raf = 0;

    const draw = () => {
      // bg
      ctx.fillStyle = "#0a0b0d";
      ctx.fillRect(0, 0, W, H);
      // grid
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= cols; i++) { ctx.moveTo(i * cell + 0.5, 0); ctx.lineTo(i * cell + 0.5, H); }
      for (let j = 0; j <= rows; j++) { ctx.moveTo(0, j * cell + 0.5); ctx.lineTo(W, j * cell + 0.5); }
      ctx.stroke();

      // trail
      for (const t of trail) {
        ctx.fillStyle = hexA(color, 0.6);
        ctx.shadowColor = color; ctx.shadowBlur = 8;
        ctx.fillRect(t.x * cell + 2, t.y * cell + 2, cell - 4, cell - 4);
      }
      ctx.shadowBlur = 0;

      // head
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 14;
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);

      // username label
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.fillText(username, x * cell + cell / 2, y * cell - 4);
      ctx.shadowBlur = 0;
    };

    const step = () => {
      frame++;
      if (frame % 6 === 0) {
        trail.push({ x, y });
        if (trail.length > 18) trail.shift();
        x += dir[0]; y += dir[1];
        // turn at edges
        if (x >= cols - 2) dir = [0, 1];
        else if (y >= rows - 2) dir = [-1, 0];
        else if (x <= 1) dir = [0, -1];
        else if (y <= 1) dir = [1, 0];
      }
      draw();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [color, username]);

  return (
    <div className="rounded-lg overflow-hidden border border-white/10">
      <canvas ref={canvasRef} width={340} height={140} className="w-full block" style={{ imageRendering: "pixelated" }} />
    </div>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
