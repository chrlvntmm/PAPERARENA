import { z } from "zod";

function optionalUrl() {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  );
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive().optional(),
  WS_PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]),
  DATABASE_SSL_REJECT_UNAUTHORIZED: z.enum(["true", "false"]),
  DATABASE_POOL_MAX: z.coerce.number().int().positive(),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive(),
  RATE_LIMIT_AUTH_CHALLENGE_MAX: z.coerce.number().int().positive(),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive(),
  RATE_LIMIT_WS_CONNECT_MAX: z.coerce.number().int().positive(),
  AUTH_APP_NAME: z.string().min(1),
  AUTH_COOKIE_NAME: z.string().min(1),
  AUTH_SESSION_SECRET: z.string().min(32),
  AUTH_ALLOWED_ORIGINS: z.string().min(1),
  AUTH_EXPECTED_DOMAIN: z.string().min(1),
  AUTH_EXPECTED_URI: z.string().url(),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive(),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive(),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]),
  AUTH_COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]),
  ETH_RPC_URL: optionalUrl(),
  SEPOLIA_RPC_URL: optionalUrl(),
  SOLANA_RPC_URL: optionalUrl(),
  SOLANA_AUTH_BYPASS: z.enum(["true", "false"]).optional(),
  ESCROW_BYPASS: z.enum(["true", "false"]).optional(),
  AUTH_DEV_BYPASS: z.enum(["true", "false"]).optional(),
  LOGIC_TICK_MS: z.coerce.number().int().positive(),
  MOVEMENT_TICKS_PER_STEP: z.coerce.number().int().positive(),
  BROADCAST_HZ: z.coerce.number().int().positive(),
  PRE_MATCH_COUNTDOWN_MS: z.coerce.number().int().nonnegative(),
  DISCONNECT_GRACE_MS: z.coerce.number().int().nonnegative(),
  PLATFORM_FEE: z.coerce.number().min(0).max(1),
  STANDARD_ARENA_PLAYERS: z.coerce.number().int().positive(),
  STANDARD_ARENA_DURATION_MS: z.coerce.number().int().positive(),
  STANDARD_ARENA_COLS: z.coerce.number().int().positive(),
  MEGA_ARENA_PLAYERS: z.coerce.number().int().positive(),
  MEGA_ARENA_DURATION_MS: z.coerce.number().int().positive(),
  MEGA_ARENA_COLS: z.coerce.number().int().positive(),
  WAGER_TIERS: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid backend environment: ${details}`);
}

const env = parsed.data;

if (
  env.NODE_ENV === "production" &&
  (env.SOLANA_AUTH_BYPASS === "true" ||
    env.ESCROW_BYPASS === "true" ||
    env.AUTH_DEV_BYPASS === "true")
) {
  throw new Error("Production cannot start with auth or escrow bypass flags enabled.");
}

const wagers = env.WAGER_TIERS.split(",").map((value) => Number(value.trim()));
if (wagers.length === 0 || wagers.some((wager) => !Number.isFinite(wager) || wager <= 0)) {
  throw new Error("WAGER_TIERS must be a comma-separated list of positive numbers.");
}

const allowedOrigins = env.AUTH_ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  throw new Error("AUTH_ALLOWED_ORIGINS must include at least one origin.");
}

const expectedUri = new URL(env.AUTH_EXPECTED_URI);
const expectedOrigin = expectedUri.origin;

if (!allowedOrigins.includes(expectedOrigin)) {
  throw new Error("AUTH_EXPECTED_URI origin must be included in AUTH_ALLOWED_ORIGINS.");
}

if (expectedUri.hostname !== env.AUTH_EXPECTED_DOMAIN) {
  throw new Error("AUTH_EXPECTED_DOMAIN must match AUTH_EXPECTED_URI hostname.");
}

if (!env.PORT && !env.WS_PORT) {
  throw new Error("PORT or WS_PORT is required.");
}

if (env.NODE_ENV === "production") {
  if (env.AUTH_COOKIE_SECURE !== "true") {
    throw new Error("Production requires AUTH_COOKIE_SECURE=true.");
  }
  if (env.AUTH_COOKIE_SAME_SITE === "none" && env.AUTH_COOKIE_SECURE !== "true") {
    throw new Error("SameSite=None cookies require AUTH_COOKIE_SECURE=true.");
  }
  if (expectedUri.protocol !== "https:") {
    throw new Error("Production requires AUTH_EXPECTED_URI to use https.");
  }
  if (allowedOrigins.some((origin) => !origin.startsWith("https://"))) {
    throw new Error("Production AUTH_ALLOWED_ORIGINS must use https origins only.");
  }
  if (env.DATABASE_SSL !== "true") {
    throw new Error("Production requires DATABASE_SSL=true.");
  }
  if (env.AUTH_SESSION_SECRET.includes("replace-with")) {
    throw new Error("Production requires a real AUTH_SESSION_SECRET.");
  }
}

export const CONFIG = {
  NODE_ENV: env.NODE_ENV,
  PORT: env.PORT ?? env.WS_PORT,
  DATABASE_URL: env.DATABASE_URL,
  DATABASE_SSL: env.DATABASE_SSL === "true",
  DATABASE_SSL_REJECT_UNAUTHORIZED: env.DATABASE_SSL_REJECT_UNAUTHORIZED === "true",
  DATABASE_POOL_MAX: env.DATABASE_POOL_MAX,
  DATABASE_CONNECTION_TIMEOUT_MS: env.DATABASE_CONNECTION_TIMEOUT_MS,
  RATE_LIMIT: {
    WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
    AUTH_CHALLENGE_MAX: env.RATE_LIMIT_AUTH_CHALLENGE_MAX,
    AUTH_VERIFY_MAX: env.RATE_LIMIT_AUTH_VERIFY_MAX,
    WS_CONNECT_MAX: env.RATE_LIMIT_WS_CONNECT_MAX,
  },
  AUTH: {
    APP_NAME: env.AUTH_APP_NAME,
    COOKIE_NAME: env.AUTH_COOKIE_NAME,
    SESSION_SECRET: env.AUTH_SESSION_SECRET,
    ALLOWED_ORIGINS: allowedOrigins,
    EXPECTED_DOMAIN: env.AUTH_EXPECTED_DOMAIN,
    EXPECTED_URI: env.AUTH_EXPECTED_URI,
    SESSION_TTL_SECONDS: env.AUTH_SESSION_TTL_SECONDS,
    CHALLENGE_TTL_SECONDS: env.AUTH_CHALLENGE_TTL_SECONDS,
    COOKIE_SECURE: env.AUTH_COOKIE_SECURE === "true",
    COOKIE_SAME_SITE: env.AUTH_COOKIE_SAME_SITE,
  },
  RPC: {
    ETHEREUM_MAINNET_URL: env.ETH_RPC_URL,
    SEPOLIA_URL: env.SEPOLIA_RPC_URL,
    SOLANA_URL: env.SOLANA_RPC_URL,
  },
  LOGIC_TICK_MS: env.LOGIC_TICK_MS,
  MOVEMENT_TICKS_PER_STEP: env.MOVEMENT_TICKS_PER_STEP,
  BROADCAST_HZ: env.BROADCAST_HZ,
  BROADCAST_MS: 1000 / env.BROADCAST_HZ,
  PRE_MATCH_COUNTDOWN_MS: env.PRE_MATCH_COUNTDOWN_MS,
  DISCONNECT_GRACE_MS: env.DISCONNECT_GRACE_MS,
  PLATFORM_FEE: env.PLATFORM_FEE,
  ARENAS: {
    standard: {
      players: env.STANDARD_ARENA_PLAYERS,
      durationMs: env.STANDARD_ARENA_DURATION_MS,
      cols: env.STANDARD_ARENA_COLS,
    },
    mega: {
      players: env.MEGA_ARENA_PLAYERS,
      durationMs: env.MEGA_ARENA_DURATION_MS,
      cols: env.MEGA_ARENA_COLS,
    },
  } as const,
  WAGERS: wagers,
} as const;

export type ArenaType = keyof typeof CONFIG.ARENAS;
export type WagerAmount = number;
