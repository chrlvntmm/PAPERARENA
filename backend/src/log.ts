import { CONFIG } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Default: quiet in dev (warn+), more detail in production if LOG_LEVEL=info. */
function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return ORDER[raw];
  }
  return CONFIG.NODE_ENV === "production" ? ORDER.info : ORDER.warn;
}

function should(level: Level) {
  return ORDER[level] >= minLevel();
}

export const log = {
  debug(tag: string, msg: string, data?: unknown) {
    if (!should("debug")) return;
    if (data !== undefined) console.debug(`[${tag}] ${msg}`, data);
    else console.debug(`[${tag}] ${msg}`);
  },
  info(tag: string, msg: string, data?: unknown) {
    if (!should("info")) return;
    if (data !== undefined) console.info(`[${tag}] ${msg}`, data);
    else console.info(`[${tag}] ${msg}`);
  },
  warn(tag: string, msg: string, data?: unknown) {
    if (!should("warn")) return;
    if (data !== undefined) console.warn(`[${tag}] ${msg}`, data);
    else console.warn(`[${tag}] ${msg}`);
  },
  error(tag: string, msg: string, data?: unknown) {
    if (!should("error")) return;
    if (data !== undefined) console.error(`[${tag}] ${msg}`, data);
    else console.error(`[${tag}] ${msg}`);
  },
};
