import { recoverStuckEscrowLocks } from "../auth/escrow.service.js";
import { CONFIG } from "../config.js";
import { log } from "../log.js";

/**
 * Lightweight recovery loop for incomplete escrow lifecycle ops.
 * Runs in-process; can later move to a dedicated worker.
 */
export function startEscrowRecoveryWorker(options: { intervalMs?: number } = {}) {
  if (CONFIG.ESCROW.BYPASS) {
    return { stop() {} };
  }

  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await recoverStuckEscrowLocks({ olderThanMs: 90_000 });
      // Only log when something actually changed.
      if (result.released > 0 || result.reconciled > 0) {
        log.info("escrow-recovery", "reconciled stuck locks", result);
      }
    } catch (error) {
      log.error("escrow-recovery", "tick failed", error);
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  handle.unref?.();

  // First pass shortly after boot.
  setTimeout(() => void tick(), 5_000).unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
