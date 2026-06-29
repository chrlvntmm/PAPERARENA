export const CONFIG = {
  PORT: Number(process.env.PORT ?? process.env.WS_PORT ?? 3001),
  LOGIC_TICK_MS: 80,
  BROADCAST_HZ: 30,
  BROADCAST_MS: 1000 / 30,
  PRE_MATCH_COUNTDOWN_MS: 5000,
  DISCONNECT_GRACE_MS: 3000,
  PLATFORM_FEE: 0.05,
  ARENAS: {
    standard: { players: 5, durationMs: 150_000, cols: 64 },
    mega: { players: 10, durationMs: 300_000, cols: 96 },
  } as const,
  WAGERS: [5, 10, 20] as const,
} as const;

export type ArenaType = keyof typeof CONFIG.ARENAS;
export type WagerAmount = (typeof CONFIG.WAGERS)[number];
