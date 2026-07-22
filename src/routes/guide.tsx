import { createFileRoute, Link } from "@tanstack/react-router";
import { playClickSound } from "@/lib/audio";

export const Route = createFileRoute("/guide")({
  head: () => ({
    meta: [
      { title: "PaperArena — How to Play & Guide" },
      { name: "description", content: "Learn the rules, controls, and economy of PaperArena. Master territory capture, survival tactics, and wallet management." },
      { property: "og:title", content: "PaperArena — How to Play & Guide" },
      { property: "og:description", content: "Master PaperArena's skill-based mechanics, controls, and economy." },
    ],
  }),
  component: GuidePage,
});

function GuidePage() {
  return (
    <main className="min-h-screen w-full grid-bg-sharp" style={{ background: "#0a0b0d" }}>
      <div className="max-w-[1100px] mx-auto px-6 py-8">
        {/* Header */}
        <header className="flex items-center justify-between mb-10">
          <div className="flex flex-col">
            <h1 className="font-display font-black text-3xl md:text-4xl tracking-tighter leading-none">
              <span className="text-white" style={{ textShadow: "0 0 20px rgba(255,255,255,0.3)" }}>PAPER</span>
              <span style={{ color: "#f4ff3a", textShadow: "0 0 20px rgba(244,255,58,0.6)" }}>ARENA</span>
            </h1>
            <div className="font-display tracking-[0.5em] text-[10px] text-white/70 mt-1">{"\n"}</div>
          </div>
          <Link
            to="/"
            onClick={() => playClickSound()}
            className="font-display text-sm tracking-[0.25em] px-5 py-2.5 rounded-lg text-[#0a0b0d] font-bold transition active:translate-y-0.5"
            style={{
              background: "linear-gradient(180deg, #fff96a 0%, #f4ff3a 50%, #d4dd1f 100%)",
              boxShadow: "0 0 20px rgba(244,255,58,0.45), 0 4px 0 rgba(120,130,10,0.6), inset 0 1px 0 rgba(255,255,255,0.6)",
            }}
          >
            ← BACK TO DASHBOARD
          </Link>
        </header>

        {/* Title */}
        <div className="text-center mb-10">
          <h1 className="font-display font-black text-4xl md:text-5xl tracking-tight text-white">
            HOW TO <span style={{ color: "#f4ff3a", textShadow: "0 0 20px rgba(244,255,58,0.5)" }}>PLAY</span>
          </h1>
          <div className="font-display tracking-[0.4em] text-xs text-white/50 mt-2">GUIDE CENTER — MASTER THE ARENA</div>
        </div>

        {/* Panels Grid */}
        <div className="space-y-6">
          {/* Section 1: Core Gameplay Rules */}
          <Widget>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-8 h-8 rounded-md flex items-center justify-center font-display font-black text-sm" style={{ background: "#f4ff3a", color: "#0a0b0d" }}>01</div>
              <h2 className="font-display text-2xl font-black text-white tracking-wide">Core Gameplay Rules</h2>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-display text-sm tracking-[0.3em] text-white/60 mb-3">MOVEMENT</h3>
                <p className="text-white/80 text-sm leading-relaxed mb-3">
                  Control your avatar with 90-degree directional input. Use <span className="text-[#f4ff3a] font-mono font-bold">WASD</span>, <span className="text-[#f4ff3a] font-mono font-bold">ZQSD</span>, or the <span className="text-[#f4ff3a] font-mono font-bold">Arrow Keys</span> to move Up, Down, Left, or Right. There is no diagonal movement.
                </p>
                <div className="rounded-lg p-3 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <div className="font-mono text-xs text-white/50 mb-1">KEYMAP</div>
                  <div className="grid grid-cols-4 gap-2 text-center font-mono text-xs">
                    <div className="rounded py-1.5 border border-white/10 text-white/70">W ↑</div>
                    <div className="rounded py-1.5 border border-white/10 text-white/70">A ←</div>
                    <div className="rounded py-1.5 border border-white/10 text-white/70">S ↓</div>
                    <div className="rounded py-1.5 border border-white/10 text-white/70">D →</div>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="font-display text-sm tracking-[0.3em] text-white/60 mb-3">OBJECTIVE</h3>
                <p className="text-white/80 text-sm leading-relaxed mb-3">
                  The objective of PaperArena is to conquer as much territory as possible — and maximize its real-time cash value — within the time limit, without getting eliminated. Leave your home territory and draw a colored trail across the grid. To capture land, you must <span className="text-[#f4ff3a] font-bold">return safely</span> to your own territory, closing the loop. The enclosed area instantly fills with your color, expanding your domain and its live cash valuation.
                </p>
                <div className="rounded-lg p-3 border border-[#f4ff3a]/20" style={{ background: "rgba(244,255,58,0.05)" }}>
                  <div className="font-display text-xs tracking-wider text-[#f4ff3a]">PRO TIP</div>
                  <p className="text-white/60 text-xs mt-1">The larger the loop, the more territory you claim — but the longer you're exposed.</p>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t border-white/10">
              <h3 className="font-display text-sm tracking-[0.3em] text-white/60 mb-4">PERMADEATH — HOW YOU LOSE</h3>
              <div className="grid md:grid-cols-3 gap-4">
                <div className="rounded-xl p-4 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <div className="font-display font-bold text-white text-sm mb-2">Murdered / Trail Cut</div>
                  <p className="text-white/70 text-xs leading-relaxed">
                    An opponent intersects or crosses your open, unclosed trail while you are outside your safe zone. You are instantly eliminated, and your entire territory vanishes.
                  </p>
                </div>
                <div className="rounded-xl p-4 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <div className="font-display font-bold text-white text-sm mb-2">Encirclement</div>
                  <p className="text-white/70 text-xs leading-relaxed">
                    An enemy successfully wraps their trail completely around your territory, trapping you within their new expansion. You are eliminated immediately.
                  </p>
                </div>
                <div className="rounded-xl p-4 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <div className="font-display font-bold text-white text-sm mb-2">Self-Elimination</div>
                  <p className="text-white/70 text-xs leading-relaxed">
                    You collide with your own active, unclosed trail, or crash into the outer boundary walls of the arena grid. Instant failure — your match value drops to <span className="text-[#ff3a6b] font-bold">$0.00</span>.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t border-white/10">
              <h3 className="font-display text-sm tracking-[0.3em] text-white/60 mb-4">VICTORY CONDITIONS — HOW YOU WIN</h3>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl p-4 border border-[#22c55e]/20" style={{ background: "rgba(34,197,94,0.05)" }}>
                  <div className="font-display font-bold text-white text-sm mb-2">Survival & Expansion</div>
                  <p className="text-white/70 text-xs leading-relaxed">
                    Conquer a map area larger than your initial entry fee and survive until the match timer hits <span className="text-[#f4ff3a] font-mono font-bold">00:00</span>. Standard Arena matches last a fast-paced <span className="text-[#f4ff3a] font-bold">2:30</span> (2.5 minutes); Mega Arena matches run the full <span className="text-[#f4ff3a] font-bold">5:00</span>. You instantly cash out the final live valuation of your held territory percentage.
                  </p>
                </div>
                <div className="rounded-xl p-4 border border-[#f4ff3a]/20" style={{ background: "rgba(244,255,58,0.05)" }}>
                  <div className="font-display font-bold text-white text-sm mb-2">Dominant Victory (100% Capture)</div>
                  <p className="text-white/70 text-xs leading-relaxed">
                    Completely conquering <span className="text-[#f4ff3a] font-bold">100%</span> of the arena canvas grid triggers an instant match freeze and awards you the absolute maximum value immediately, bypassing the remaining timer.
                  </p>
                </div>
              </div>
            </div>

            {/* House Fee Notice */}
            <div className="mt-6 rounded-lg p-4 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
              <div className="flex items-start gap-3">
                <InfoIcon />
                <div>
                  <div className="font-display text-xs tracking-wider text-white/60 mb-2">UNCLAIMED POT & PLATFORM FEE NOTICE</div>
                  <p className="text-white/50 text-xs leading-relaxed">
                    If less than 100% of the map is claimed when the timer ends, or if the last remaining player self-eliminates before the match concludes, all remaining unclaimed funds are permanently forfeited to The House (the platform). These retained unclaimed funds, alongside the standard 2% platform fee deducted from payouts, are strictly utilized by the platform owner to keep the gaming servers running smoothly, fund future development updates, maintain security infrastructure, and optimize the overall user experience.
                  </p>
                </div>
              </div>
            </div>
          </Widget>

          {/* Section 2: Wallet & Balance */}
          <Widget>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-8 h-8 rounded-md flex items-center justify-center font-display font-black text-sm" style={{ background: "#22c55e", color: "#0a0b0d" }}>02</div>
              <h2 className="font-display text-2xl font-black text-white tracking-wide">Wallet & Balance Guide</h2>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="rounded-xl p-5 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#22c55e" }} />
                  <h3 className="font-display text-sm tracking-[0.2em] text-white font-bold">ADDING FUNDS</h3>
                </div>
                <p className="text-white/70 text-sm leading-relaxed mb-3">
                  Connect your wallet (e.g. <span className="text-[#f4ff3a] font-bold">Phantom</span>, <span className="text-[#f4ff3a] font-bold">Metamask</span> or <span className="text-[#f4ff3a] font-bold">Solflare</span>) and click the green <span className="text-[#22c55e] font-bold">"Add Funds"</span> button on the dashboard.
                </p>
                <p className="text-white/60 text-xs leading-relaxed">
                  Deposit SOL directly from your wallet to load your Paper Arena wallet balance in real-time.
                </p>
                <div className="mt-3 font-mono text-xs text-white/40">1 USD ≈ 0.014 SOL</div>
              </div>

              <div className="rounded-xl p-5 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#818cf8" }} />
                  <h3 className="font-display text-sm tracking-[0.2em] text-white font-bold">CASHING OUT</h3>
                </div>
                <p className="text-white/70 text-sm leading-relaxed mb-3">
                  When you win or conclude a match, your claimed territory value is automatically calculated. A minimal <span className="text-[#f4ff3a] font-bold">2% platform fee</span> is deducted at cash-out, and the net payout is immediately available to withdraw back to your Web3 wallet.
                </p>
                <p className="text-white/60 text-xs leading-relaxed">
                  Click the purple <span className="text-[#818cf8] font-bold">"Cash Out"</span> button to simulate withdrawing winnings securely to a Web3 wallet such as Phantom or MetaMask.
                </p>
                <div className="mt-3 rounded-lg p-2 border border-white/10" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <div className="font-mono text-[10px] text-white/50">PRIZE FORMULA</div>
                  <div className="font-mono text-xs text-white/80 mt-0.5">Net Payout = Captured Territory Value − 2% Platform Fee</div>
                </div>
              </div>
            </div>
          </Widget>

          {/* Section 3: Fair Play */}
          <Widget>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-8 h-8 rounded-md flex items-center justify-center font-display font-black text-sm" style={{ background: "#3afff0", color: "#0a0b0d" }}>03</div>
              <h2 className="font-display text-2xl font-black text-white tracking-wide">Platform Legitimacy & Fair Play</h2>
            </div>

            <div className="flex flex-col md:flex-row gap-6 items-start">
              <div className="flex-1">
                <p className="text-white/80 text-sm leading-relaxed mb-4">
                  PaperArena is a <span className="text-[#f4ff3a] font-bold">100% Skill-Based Platform</span> with zero elements of chance. There are no random number generators, no loot boxes, and no luck-based outcomes.
                </p>
                <p className="text-white/60 text-sm leading-relaxed mb-4">
                  Your financial outcome is dictated entirely by your <span className="text-white font-bold">performance, reaction speed, spatial awareness, and tactical decision-making</span>. Every elimination, capture, and victory is earned through skill alone.
                </p>
                <div className="rounded-lg p-3 border border-[#3afff0]/20 flex items-center gap-3" style={{ background: "rgba(58,255,240,0.05)" }}>
                  <ShieldIcon />
                  <div className="font-display text-xs tracking-wider text-[#3afff0]">PROVABLY FAIR · NO RNG · PURE SKILL</div>
                </div>
              </div>

              <div className="w-full md:w-64 rounded-xl p-4 border border-white/10 shrink-0" style={{ background: "rgba(255,255,255,0.03)" }}>
                <div className="font-display text-xs tracking-[0.3em] text-white/50 mb-3">SKILL FACTORS</div>
                <div className="space-y-2">
                  {SKILL_ITEMS.map(item => (
                    <div key={item} className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#f4ff3a" }} />
                      <span className="text-white/70 text-xs font-medium">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Widget>
        </div>

        {/* Bottom CTA */}
        <div className="text-center mt-10 mb-8">
          <Link
            to="/"
            onClick={() => playClickSound()}
            className="inline-block font-display font-black tracking-[0.2em] text-sm px-8 py-4 rounded-xl text-[#0a0b0d] transition active:translate-y-0.5"
            style={{
              background: "linear-gradient(180deg, #fff96a 0%, #f4ff3a 50%, #d4dd1f 100%)",
              boxShadow: "0 0 30px rgba(244,255,58,0.5), 0 6px 0 rgba(120,130,10,0.6), inset 0 1px 0 rgba(255,255,255,0.6)",
            }}
          >
            ENTER THE ARENA →
          </Link>
        </div>

        <footer className="text-center text-[10px] tracking-[0.4em] text-white/40 font-display pb-4">
          PAPERARENA · SKILL-BASED BETTING · MVP
        </footer>
      </div>
    </main>
  );
}

function Widget({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-6 border border-white/10"
      style={{
        background: "linear-gradient(180deg, rgba(20,22,26,0.95) 0%, rgba(14,15,18,0.95) 100%)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {children}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L4 6v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V6l-8-4z" stroke="#3afff0" strokeWidth="2" fill="none" />
      <path d="M9 12l2 2 4-4" stroke="#3afff0" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.4)" strokeWidth="2" />
      <path d="M12 7v1m0 4v5" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7" r="1" fill="rgba(255,255,255,0.4)" />
    </svg>
  );
}

const SKILL_ITEMS = [
  "Reaction Speed",
  "Spatial Awareness",
  "Tactical Pathing",
  "Risk Management",
  "Timing & Precision",
];
