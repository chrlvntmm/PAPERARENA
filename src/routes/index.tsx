import "@/lib/buffer-polyfill";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Copy, Instagram, LogOut, MessageCircle, Music2, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Game from "@/game/Game";
import { useGameSocket } from "@/game/useGameSocket";
import { useWallet, formatPlayableBalance } from "@/lib/wallet";
import { playClickSound, playWinSound, installAudioUnlock } from "@/lib/audio";
import {
  confirmDeposit,
  createDepositIntent,
  listOpenDeposits,
  refundDeposit,
  type DepositIntent,
} from "@/lib/deposit";
import { sendDepositTransaction } from "@/lib/deposit-tx";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";

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
// Smaller local lobbies only — does NOT skip escrow deposits.
const DEV_MATCH_ENTRY = import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_MATCH_ENTRY === "true";
const DEV_STANDARD_ARENA_PLAYERS = Number(import.meta.env.VITE_DEV_STANDARD_ARENA_PLAYERS);
// Only skip on-chain deposit when backend also has ESCROW_BYPASS=true.
const SKIP_DEPOSIT = import.meta.env.DEV && import.meta.env.VITE_SKIP_DEPOSIT === "true";

if (import.meta.env.PROD && import.meta.env.VITE_SKIP_DEPOSIT === "true") {
  throw new Error("VITE_SKIP_DEPOSIT cannot be enabled in production builds.");
}

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

type LobbyPhase = "idle" | "queueing" | "in_match";

function Index() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const socket = useGameSocket();
  const [players, setPlayers] = useState(5);
  const [wager, setWager] = useState(10);
  const [phase, setPhase] = useState<LobbyPhase>("idle");
  const [username, setUsername] = useState("");
  const [skin, setSkin] = useState(SKIN_COLORS[0]);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameSaved, setUsernameSaved] = useState(false);
  const [walletCopied, setWalletCopied] = useState(false);
  const [joinStatus, setJoinStatus] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const joinPendingRef = useRef(false);
  /** Deposit verified for current join/queue — auto-refund if join cancels/fails (never after match start). */
  const activeDepositIntentIdRef = useRef<string | null>(null);
  const orphanRefundRanRef = useRef(false);
  /** Only seed the field once from server/random — never fight the user while typing. */
  const usernameSeededRef = useRef(false);
  /** Warm deposit intent while idle so JOIN does not wait on a cold create. */
  const depositPrefetchRef = useRef<{
    arena: "standard" | "mega";
    wager: number;
    walletId: string;
    intent: DepositIntent;
    fetchedAt: number;
  } | null>(null);

  useEffect(() => { installAudioUnlock(); }, []);

  useEffect(() => {
    if (wallet.loading) return;
    if (usernameSeededRef.current) return;

    if (wallet.user?.displayName) {
      setUsername(wallet.user.displayName);
      usernameSeededRef.current = true;
      return;
    }
    // Connected with no saved name, or still loading session done with no user.
    if (wallet.connected || wallet.user) {
      setUsername((current) => current || `PLAYER_${Math.floor(1000 + Math.random() * 9000)}`);
      usernameSeededRef.current = true;
    }
  }, [wallet.loading, wallet.connected, wallet.user, wallet.user?.displayName]);

  // After sign-out, allow re-seed on next login.
  useEffect(() => {
    if (!wallet.connected && !wallet.user) {
      usernameSeededRef.current = false;
    }
  }, [wallet.connected, wallet.user]);

  useEffect(() => {
    if (socket.matchId && socket.playerId != null && socket.snapshot) {
      // Deposit is in the match pot — never refund from lobby after this.
      activeDepositIntentIdRef.current = null;
      depositPrefetchRef.current = null;
      setPhase("in_match");
    }
  }, [socket.matchId, socket.playerId, socket.snapshot]);

  // Keep in-match UI while auto-reconnecting after a brief drop.
  useEffect(() => {
    if (socket.reconnecting && socket.matchId) {
      setPhase("in_match");
    }
  }, [socket.reconnecting, socket.matchId]);

  useEffect(() => {
    if (!socket.error || phase !== "queueing") return;
    joinPendingRef.current = false;
    const depositId = activeDepositIntentIdRef.current;
    setWalletActionError(socket.error);
    // Lock/join failed while still holding a Funded deposit → auto return.
    if (depositId && !SKIP_DEPOSIT && wallet.solanaWallet) {
      setJoinStatus("Match failed — returning deposit…");
      void (async () => {
        try {
          await refundDeposit({
            depositIntentId: depositId,
            walletId: wallet.solanaWallet!.id,
          });
          activeDepositIntentIdRef.current = null;
          depositPrefetchRef.current = null;
          void wallet.refresh();
        } catch {
          /* recovery worker / retry on next idle may still refund */
        } finally {
          setJoinStatus(null);
          setPhase("idle");
        }
      })();
      return;
    }
    setJoinStatus(null);
    setPhase("idle");
  }, [phase, socket.error, wallet, wallet.solanaWallet]);

  const totalPot = players * wager;
  const fee = totalPot * PLATFORM_FEE;
  const isQueueing = phase === "queueing";
  const isSessionLoading = wallet.loading;
  const arena = players === 5 ? "standard" as const : "mega" as const;

  // Prefetch a real deposit intent while the player is idle (same arena/wager).
  // Backend reuses open intents; this only warms HTTP + PDA build params.
  useEffect(() => {
    if (SKIP_DEPOSIT) return;
    if (phase !== "idle") return;
    if (wallet.loading || !wallet.connected || !wallet.solanaWallet) return;

    const walletId = wallet.solanaWallet.id;
    const cached = depositPrefetchRef.current;
    const freshEnough =
      cached &&
      cached.arena === arena &&
      cached.wager === wager &&
      cached.walletId === walletId &&
      Date.now() - cached.fetchedAt < 4 * 60_000 &&
      (cached.intent.status === "awaiting_payment" ||
        cached.intent.status === "verified" ||
        cached.intent.status === "submitted");
    if (freshEnough) return;

    let cancelled = false;
    void (async () => {
      try {
        const intent = await createDepositIntent({ arena, wager, walletId });
        if (cancelled) return;
        if (
          intent.status === "awaiting_payment" ||
          intent.status === "verified" ||
          intent.status === "submitted"
        ) {
          depositPrefetchRef.current = {
            arena,
            wager,
            walletId,
            intent,
            fetchedAt: Date.now(),
          };
        }
      } catch {
        /* prefetch is best-effort; join still creates a real intent */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    arena,
    phase,
    wager,
    wallet.connected,
    wallet.loading,
    wallet.solanaWallet,
    wallet.solanaWallet?.id,
  ]);

  // One-shot: silently refund any leftover unused deposits from earlier failed joins.
  useEffect(() => {
    if (SKIP_DEPOSIT) return;
    if (phase !== "idle") return;
    if (wallet.loading || !wallet.connected || !wallet.solanaWallet) return;
    if (orphanRefundRanRef.current) return;
    if (joinPendingRef.current || activeDepositIntentIdRef.current) return;

    orphanRefundRanRef.current = true;
    const walletId = wallet.solanaWallet.id;
    void (async () => {
      try {
        const deposits = await listOpenDeposits({ walletId });
        for (const d of deposits) {
          if (d.status !== "verified" && d.status !== "expired") continue;
          try {
            await refundDeposit({ depositIntentId: d.id, walletId });
          } catch {
            /* skip blocked (in match) or transient */
          }
        }
        if (deposits.length > 0) void wallet.refresh();
      } catch {
        orphanRefundRanRef.current = false;
      }
    })();
  }, [phase, wallet, wallet.connected, wallet.loading, wallet.solanaWallet]);

  const expectedQueueNeeded =
    socket.queueNeeded ??
    (DEV_MATCH_ENTRY && arena === "standard" ? DEV_STANDARD_ARENA_PLAYERS : players);
  const displayUsername = username || "Player";
  const walletLabel = wallet.primaryWallet
    ? `${wallet.primaryWallet.address.slice(0, 4)}...${wallet.primaryWallet.address.slice(-4)}`
    : "CONNECT WALLET";
  const connectWalletLabel = isSessionLoading
    ? "One moment…"
    : wallet.connected
    ? walletLabel
    : wallet.solanaWalletReady || wallet.hasWalletConnection
      ? "SIGN WALLET"
      : "CONNECT WALLET";
  const balanceWalletLabel = wallet.solanaWallet
    ? `${wallet.solanaWallet.address.slice(0, 4)}...${wallet.solanaWallet.address.slice(-4)}`
    : wallet.primaryWallet
      ? `${wallet.primaryWallet.address.slice(0, 4)}...${wallet.primaryWallet.address.slice(-4)}`
      : "Wallet not connected";
  const normalizedUsername = normalizeUsername(username);
  const usernameValid = /^[A-Z0-9_]{3,16}$/.test(normalizedUsername);
  const usernameDirty = wallet.connected && normalizedUsername !== (wallet.user?.displayName ?? "");

  const handleCopyWallet = async () => {
    playClickSound();
    const address = wallet.solanaWallet?.address ?? wallet.primaryWallet?.address;
    if (isSessionLoading || !address) return;
    try {
      await navigator.clipboard.writeText(address);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : "Could not copy wallet address.");
    }
  };

  const handleRefreshWallet = async () => {
    playClickSound();
    if (isSessionLoading) return;
    setWalletActionError(null);
    await wallet.refreshBalance();
  };

  const playableLabel = formatPlayableBalance(
    wallet.playableBalance,
    wallet.playableBalanceSymbol,
  );

  const handleDisconnectWallet = async () => {
    playClickSound();
    if (isSessionLoading) return;
    setWalletActionError(null);
    try {
      await wallet.signOut();
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : "Could not disconnect wallet.");
    }
  };

  const handleConnectSolana = async () => {
    playClickSound();
    if (isSessionLoading) return;
    setWalletActionError(null);
    try {
      await wallet.signInSolana();
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : "Could not connect a Solana wallet.");
    }
  };

  const saveUsername = async () => {
    if (isSessionLoading) return false;
    setUsernameError(null);
    setUsernameSaved(false);
    const nextUsername = normalizeUsername(username);

    if (!/^[A-Z0-9_]{3,16}$/.test(nextUsername)) {
      setUsernameError("Use 3-16 letters, numbers, or underscore.");
      return false;
    }

    if (!wallet.connected) {
      setUsernameError("Connect wallet before saving username.");
      return false;
    }

    if (nextUsername === wallet.user?.displayName) {
      setUsername(nextUsername);
      return true;
    }

    setUsernameSaving(true);
    try {
      const user = await wallet.updateDisplayName(nextUsername);
      setUsername(user.displayName ?? nextUsername);
      setUsernameSaved(true);
      window.setTimeout(() => setUsernameSaved(false), 1200);
      return true;
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : "Could not save username.");
      return false;
    } finally {
      setUsernameSaving(false);
    }
  };

  const handleSaveUsername = async () => {
    playClickSound();
    await saveUsername();
  };

  const handleJoin = async () => {
    playClickSound();
    if (isSessionLoading) return;
    if (!wallet.connected || !wallet.solanaWallet) {
      await handleConnectSolana();
      return;
    }
    if (!(await saveUsername())) return;
    if (isQueueing) return;

    joinPendingRef.current = true;
    setWalletActionError(null);
    setPhase("queueing");

    try {
      // Open WS + auth while deposit runs — real session, not a fake ready state.
      setJoinStatus(SKIP_DEPOSIT ? "Connecting to arena…" : "Preparing deposit…");
      socket.connect();

      let depositIntentId: string | undefined;

      if (!SKIP_DEPOSIT) {
        if (!wallet.solanaWallet) {
          throw new Error("Connect a Solana wallet to deposit and join.");
        }
        if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
          throw new Error("Solana wallet is not ready to sign the deposit. Open your Solana wallet and try again.");
        }

        const walletId = wallet.solanaWallet.id;
        const pref = depositPrefetchRef.current;
        let intent: DepositIntent | null =
          pref &&
          pref.arena === arena &&
          pref.wager === wager &&
          pref.walletId === walletId &&
          Date.now() - pref.fetchedAt < 4 * 60_000 &&
          (pref.intent.status === "awaiting_payment" ||
            pref.intent.status === "verified" ||
            pref.intent.status === "submitted") &&
          (pref.intent.status === "verified" || pref.intent.build)
            ? pref.intent
            : null;

        if (!intent) {
          setJoinStatus("Creating deposit intent…");
          intent = await createDepositIntent({
            arena,
            wager,
            walletId,
          });
        } else {
          setJoinStatus("Using prepared deposit…");
        }

        if (intent.status === "verified") {
          depositIntentId = intent.id;
        } else if (intent.build) {
          setJoinStatus("Approve deposit in your wallet…");
          const txSignature = await sendDepositTransaction({
            build: intent.build,
            playerPublicKey: solanaWallet.publicKey,
            signTransaction: solanaWallet.signTransaction.bind(solanaWallet),
          });
          setJoinStatus("Confirming deposit on-chain…");
          const confirmed = await confirmDeposit({
            depositIntentId: intent.id,
            txSignature,
            walletId,
          });
          if (confirmed.status !== "verified") {
            throw new Error(confirmed.verificationError ?? "Deposit was not verified.");
          }
          depositIntentId = confirmed.id;
        } else if (intent.contractStatus === "not_configured") {
          throw new Error(intent.verificationError ?? "Escrow contract is not configured.");
        } else {
          throw new Error(
            intent.verificationError ??
              "Deposit is not ready. Ensure the backend escrow program is configured and try again.",
          );
        }

        // Intent consumed for this join path — clear so next join warms a new one.
        depositPrefetchRef.current = null;

        if (!depositIntentId) {
          throw new Error("Deposit verification is required before joining.");
        }
        activeDepositIntentIdRef.current = depositIntentId;
      }

      setJoinStatus("Connecting to arena…");
      // Auth usually finished during deposit; wait only if still opening.
      await socket.waitForAuth();
      if (!joinPendingRef.current) {
        // User cancelled mid-join after deposit — auto refund.
        await autoRefundActiveDeposit("Cancelled — returning deposit…");
        setPhase("idle");
        return;
      }

      setJoinStatus("Joining queue…");
      await socket.joinQueue(
        arena,
        wager,
        normalizedUsername || "PLAYER",
        skin,
        depositIntentId,
      );
      // Server accepted join (queue_update / match_preparing / match_start).
      setJoinStatus(null);
    } catch (err) {
      joinPendingRef.current = false;
      setWalletActionError(err instanceof Error ? err.message : "Could not join match.");
      await autoRefundActiveDeposit("Join failed — returning deposit…");
      setJoinStatus(null);
      setPhase("idle");
    }
  };

  /** Silent/status auto-refund for unused deposit. Never runs after match start (ref cleared). */
  const autoRefundActiveDeposit = async (statusMsg?: string) => {
    const depositId = activeDepositIntentIdRef.current;
    if (!depositId || SKIP_DEPOSIT || !wallet.solanaWallet) return;
    if (statusMsg) setJoinStatus(statusMsg);
    setRefundBusy(true);
    try {
      await refundDeposit({
        depositIntentId: depositId,
        walletId: wallet.solanaWallet.id,
      });
      activeDepositIntentIdRef.current = null;
      depositPrefetchRef.current = null;
      void wallet.refresh();
    } catch {
      // Leave id so orphan cleanup / server recovery can still try.
    } finally {
      setRefundBusy(false);
      if (statusMsg) setJoinStatus(null);
    }
  };

  const handleCancelQueue = () => {
    playClickSound();
    joinPendingRef.current = false;
    socket.leaveQueue();
    const depositId = activeDepositIntentIdRef.current;
    if (depositId && !SKIP_DEPOSIT) {
      setPhase("queueing");
      void (async () => {
        await autoRefundActiveDeposit("Leaving queue — returning deposit…");
        setPhase("idle");
      })();
      return;
    }
    setJoinStatus(null);
    setPhase("idle");
  };

  const handleGameEnd = (result: { won: boolean; payout?: number }) => {
    joinPendingRef.current = false;
    setJoinStatus(null);
    // Match used the deposit — never refund from client after a real game.
    activeDepositIntentIdRef.current = null;
    depositPrefetchRef.current = null;
    if (result.won) playWinSound();
    socket.reset();
    socket.disconnect();
    setPhase("idle");
    // One balance refresh; extra quiet polls only if a win payout may still land.
    void wallet.refreshBalanceAfterMatch({ expectPayout: Boolean(result.won) });
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
      <div className="mx-auto max-w-[1440px] px-3 py-4 sm:px-5 sm:py-6 lg:px-6">
        {/* Header */}
        <header className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-6 sm:mb-8">
          <span className="min-w-0 break-words font-display text-base tracking-[0.1em] text-white sm:text-xl sm:tracking-widest">
            {isSessionLoading && !username ? (
              "Welcome"
            ) : (
              <>
                Welcome,{" "}
                <span className="break-all" style={{ color: "#f4ff3a" }}>
                  {displayUsername}
                </span>
              </>
            )}
          </span>
          <div className="flex flex-col min-[420px]:flex-row sm:flex-row items-stretch sm:items-center gap-3">
            <Link
              to="/guide"
              onClick={() => playClickSound()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/10 px-4 py-3 font-display text-[11px] tracking-[0.14em] text-white/80 transition hover:border-[#f4ff3a]/50 hover:bg-[#f4ff3a]/5 hover:text-[#f4ff3a] sm:text-xs sm:tracking-[0.25em]"
            >
              <HelpIcon /> HOW TO PLAY
            </Link>
            <button
              onClick={wallet.connected ? handleDisconnectWallet : handleConnectSolana}
              disabled={isSessionLoading}
              className="min-h-11 rounded-md px-5 py-3 font-display text-[11px] tracking-[0.14em] neon-border transition hover:bg-white/5 disabled:cursor-wait disabled:opacity-60 sm:text-xs sm:tracking-[0.3em]"
            >
              {connectWalletLabel}
            </button>
          </div>
        </header>

        {/* Title */}
        <div className="text-center mb-6 sm:mb-8">
          <h1
            className="font-display font-black leading-none max-w-full overflow-hidden"
            style={{ fontSize: "clamp(2.15rem, 11.5vw, 4.5rem)" }}
          >
            <span className="block min-[420px]:inline text-white" style={{ textShadow: "0 0 20px rgba(255,255,255,0.3)" }}>PAPER</span>
            <span className="block min-[420px]:inline" style={{ color: "#f4ff3a", textShadow: "0 0 20px rgba(244,255,58,0.6)" }}>ARENA</span>
          </h1>
        </div>

        <section className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.25fr)_minmax(250px,0.9fr)] max-w-[1360px] mx-auto">
          {/* Community */}
          <Widget>
            <div className="mb-5 flex items-center gap-2">
              <UsersRound size={20} className="text-[#f4ff3a]" />
              <span className="whitespace-nowrap font-display text-[11px] tracking-[0.06em] text-white">COMMUNITY &amp; SOCIALS</span>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-white/60">
              Follow our socials for updates, special events, and giveaways!
            </p>

            <a
              href="https://paperarena.vercel.app/#"
              className="group flex min-h-14 items-center gap-3 rounded-md border border-[#f4ff3a]/45 px-3 py-3 transition hover:border-[#f4ff3a] hover:bg-[#f4ff3a]/5"
            >
              <MessageCircle size={22} className="shrink-0 text-white" />
              <span className="min-w-0 flex-1">
                <span className="block font-display text-sm tracking-[0.08em] text-white">Join the Community</span>
                <span className="block text-xs text-white/50">Discord Server</span>
              </span>
              <ArrowRight size={18} className="shrink-0 text-[#f4ff3a] transition-transform group-hover:translate-x-0.5" />
            </a>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <SocialLink href="https://www.instagram.com/paper.arena?igsh=MWxvcnJhN2YxczI1aw%3D%3D&utm_source=qr" label="Instagram" icon={<Instagram size={21} />} />
              <SocialLink href="https://www.tiktok.com/@paper.arena?_r=1&_t=ZN-98EGqULTT8A" label="TikTok" icon={<Music2 size={21} />} />
              <SocialLink href="https://paperarena.vercel.app/#" label="X" icon={<XLogo />} />
            </div>
          </Widget>

          {/* Matchmaking */}
          <Widget>
            <div className="text-center mb-5">
              <div className="font-display text-xs tracking-[0.4em] text-white/50">CONFIGURE MATCH</div>
            </div>


            <Section label="ARENA SIZE">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {PLAYER_OPTIONS.map(opt => (
                  <button
                    key={opt.n}
                    onClick={() => { if (!isQueueing) { playClickSound(); setPlayers(opt.n); } }}
                    disabled={isQueueing}
                    className={`min-h-[92px] rounded-lg border-2 px-3 py-4 transition ${
                      players === opt.n
                        ? "border-[#f4ff3a] bg-[#f4ff3a]/10"
                        : "border-white/10 hover:border-white/30"
                    } ${isQueueing ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <div className={`font-display font-black text-base sm:text-lg leading-tight break-words ${players === opt.n ? "text-[#f4ff3a]" : "text-white"}`}>{opt.display}</div>
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
                    className={`min-h-14 rounded-lg py-3 font-display text-xl font-black transition sm:py-4 sm:text-2xl ${
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
                <div className="flex flex-col min-[420px]:flex-row min-[420px]:items-baseline justify-between gap-1">
                  <span className="text-[11px] sm:text-xs tracking-[0.22em] sm:tracking-[0.3em] font-display text-white/70">TOTAL MAP VALUE</span>
                  <span className="font-display text-3xl sm:text-4xl font-black tabular-nums" style={{ color: "#f4ff3a", textShadow: "0 0 16px rgba(244,255,58,0.6)" }}>${totalPot.toFixed(2)}</span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-xs tracking-wider font-display text-white/60">Platform Fee ({(PLATFORM_FEE * 100).toFixed(0)}%)</span>
                  <span className="font-mono text-base font-semibold text-white/60 tabular-nums">−${fee.toFixed(2)}</span>
                </div>
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
              <div className="mt-5 rounded-lg border border-[#f4ff3a]/40 p-4 text-center sm:p-6" style={{ background: "rgba(244,255,58,0.06)" }}>
                {joinStatus && (
                  <div className="mb-3 text-xs font-display tracking-wider text-white/70">{joinStatus}</div>
                )}
                <div className="flex items-center justify-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "#f4ff3a", boxShadow: "0 0 10px #f4ff3a" }} />
                  <span className="font-display text-xs tracking-[0.35em] text-[#f4ff3a]">
                    {socket.matchPreparing ? "STARTING MATCH" : "SEARCHING FOR OPPONENTS"}
                  </span>
                </div>
                <div className="font-display text-2xl font-black text-white tracking-wider mb-1">
                  {socket.matchPreparing
                    ? "LOCKING FUNDS…"
                    : `FINDING PLAYERS… ${socket.queuePosition ?? 1}/${expectedQueueNeeded}`}
                </div>
                <div className="text-[11px] text-white/50 font-display tracking-wider mb-5">
                  {!socket.connected
                    ? "Connecting to arena server…"
                    : !socket.authenticated
                      ? "Authenticating…"
                      : socket.matchPreparing
                        ? "Match found — securing escrow…"
                        : "In queue"}
                </div>
                <button
                  onClick={handleCancelQueue}
                  disabled={refundBusy || socket.matchPreparing}
                  className="min-h-12 w-full rounded-md border border-white/20 py-3 font-display text-sm font-bold tracking-[0.18em] text-white transition hover:border-white/40 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 sm:tracking-[0.25em]"
                >
                  {refundBusy
                    ? "RETURNING DEPOSIT…"
                    : socket.matchPreparing
                      ? "LOCK IN PROGRESS…"
                      : "CANCEL"}
                </button>
              </div>
            ) : (
              <>
            <button
              onClick={handleJoin}
              disabled={isSessionLoading || isQueueing || refundBusy}
              className="mt-5 min-h-14 w-full rounded-lg py-4 font-display text-base font-black tracking-[0.12em] text-[#0a0b0d] transition active:translate-y-0.5 disabled:cursor-not-allowed sm:py-5 sm:text-lg sm:tracking-[0.25em]"
              style={{
                background: "linear-gradient(180deg, #fff96a 0%, #f4ff3a 50%, #d4dd1f 100%)",
                boxShadow: "0 0 30px rgba(244,255,58,0.5), 0 6px 0 rgba(120,130,10,0.6), inset 0 1px 0 rgba(255,255,255,0.6)",
              }}
            >
              {isSessionLoading
                ? "Getting ready…"
                : !wallet.connected
                ? wallet.solanaWalletReady || wallet.hasWalletConnection
                  ? "SIGN WALLET TO JOIN"
                  : "CONNECT WALLET TO JOIN"
                : !DEV_MATCH_ENTRY && !wallet.solanaWallet
                  ? "CONNECT SOLANA WALLET"
                : "▶ JOIN GAME"}
            </button>
              </>
            )}
          </Widget>

          {/* Wallet + Customize */}
          <div className="flex flex-col gap-5">
            <Widget>
              <div className="flex flex-col min-[420px]:flex-row min-[420px]:items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <WalletIcon />
                  <span className="font-display text-xl text-white tracking-wide">Wallet</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-white/60">
                  {!wallet.solanaWallet && (
                    <button
                    onClick={handleConnectSolana}
                    disabled={isSessionLoading}
                    className="hover:text-white transition"
                  >
                      Solana
                    </button>
                  )}
                  <button
                    onClick={handleCopyWallet}
                    disabled={isSessionLoading || !wallet.solanaWallet}
                    className="inline-flex items-center gap-1 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Copy wallet address"
                  >
                    <Copy size={14} /> {walletCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={handleRefreshWallet}
                    disabled={isSessionLoading || !wallet.connected || wallet.balanceLoading}
                    className="inline-flex items-center gap-1 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Refresh playable balance"
                  >
                    <RefreshCw size={14} /> {wallet.balanceLoading ? "Refreshing" : "Refresh"}
                  </button>
                </div>
              </div>
              <div className="min-w-0 py-4 text-center">
                <div className="font-display font-black leading-none break-words" style={{ color: "#f4ff3a", textShadow: "0 0 16px rgba(244,255,58,0.5)", fontSize: "clamp(2rem, 10vw, 3rem)" }}>
                  {isSessionLoading
                    ? "…"
                    : wallet.balanceLoading && wallet.connected && playableLabel
                      ? playableLabel
                      : wallet.balanceLoading
                        ? "…"
                        : !wallet.connected
                          ? "—"
                          : playableLabel}
                </div>
                {wallet.balanceLoading && wallet.connected && (
                  <div className="mt-1 text-[10px] font-display tracking-[0.25em] text-white/45">
                    Updating balance…
                  </div>
                )}
                {wallet.connected && (
                  <div className="mt-2 flex min-w-0 items-center justify-center gap-2">
                    <div className="min-w-0 break-all font-mono text-sm text-white/60">{balanceWalletLabel}</div>
                    <button
                      onClick={handleDisconnectWallet}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded border border-white/10 text-white/55 hover:border-[#ff3a6b]/60 hover:text-[#ff3a6b] transition"
                      title="Disconnect wallet"
                      aria-label="Disconnect wallet"
                    >
                      <LogOut size={15} />
                    </button>
                  </div>
                )}
                {!wallet.connected && wallet.hasWalletConnection && (
                  <div className="mt-2 flex min-w-0 items-center justify-center gap-2">
                    <div className="text-white/50 font-mono text-sm">Wallet selected</div>
                    <button
                      onClick={handleDisconnectWallet}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded border border-white/10 text-white/55 hover:border-[#ff3a6b]/60 hover:text-[#ff3a6b] transition"
                      title="Disconnect wallet"
                      aria-label="Disconnect wallet"
                    >
                      <LogOut size={15} />
                    </button>
                  </div>
                )}
              </div>
            </Widget>

            <Widget>
              <div className="flex items-center gap-2 mb-4">
                <CustomizeIcon />
                <span className="font-display text-xl text-white tracking-wide">Customize</span>
              </div>

              <label className="text-[10px] tracking-[0.3em] text-white/60 font-display">USERNAME</label>
              <div className="mt-1 mb-2 flex flex-col min-[420px]:flex-row gap-2">
                <input
                value={username}
                onChange={e => {
                    setUsernameSaved(false);
                    setUsernameError(null);
                    setUsername(normalizeUsername(e.target.value).slice(0, 16));
                }}
                maxLength={16}
                disabled={isSessionLoading}
                className="min-w-0 flex-1 rounded-lg border-2 border-white/10 bg-white/5 px-4 py-3 text-lg tracking-wider text-white focus:border-[#f4ff3a]/60 focus:outline-none font-display sm:tracking-widest"
              />
                <button
                  onClick={handleSaveUsername}
                  disabled={isSessionLoading || !wallet.connected || !usernameValid || usernameSaving || !usernameDirty}
                  className="min-h-11 rounded-md border border-white/15 px-4 py-3 font-display text-[11px] tracking-[0.14em] text-white transition hover:border-[#f4ff3a]/60 hover:text-[#f4ff3a] disabled:cursor-not-allowed disabled:opacity-40 sm:tracking-[0.18em]"
                >
                  {usernameSaving ? "SAVING" : usernameSaved ? "SAVED" : "SAVE"}
                </button>
              </div>
              {usernameError && (
                <div className="mb-4 text-xs text-[#ff3a6b] font-display tracking-[0.1em]">
                  {usernameError}
                </div>
              )}
              {!usernameError && (
                <div className="mb-4 text-[10px] text-white/45 font-display tracking-[0.16em]">
                  {isSessionLoading ? "Checking your wallet session" : wallet.connected ? "Saved to your wallet account" : "Connect wallet to save username"}
                </div>
              )}

              <label className="text-[10px] tracking-[0.3em] text-white/60 font-display">SKIN COLOR</label>
              <div className="flex flex-wrap gap-2 mt-2 mb-4">
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

              <SkinPreview color={skin} username={displayUsername} />
            </Widget>
          </div>
        </section>

        <footer className="mt-12 text-center text-[10px] tracking-[0.4em] text-white/40 font-display">
          PAPERARENA · SKILL-BASED BETTING
        </footer>
      </div>
    </main>
  );
}

function SocialLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-md border border-white/10 px-2 text-white/65 transition hover:border-white/35 hover:bg-white/5 hover:text-white"
      aria-label={label}
    >
      {icon}
      <span className="font-display text-[10px] tracking-[0.08em]">{label}</span>
    </a>
  );
}

function XLogo() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
    </svg>
  );
}

function Widget({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-w-0 rounded-lg border border-white/10 p-4 sm:p-5"
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
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 text-sm text-white/70">{label}</span>
      <span className={`shrink-0 font-mono text-base font-semibold ${muted ? "text-white/50" : "text-white"}`}>{value}</span>
    </div>
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

function normalizeUsername(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
}
