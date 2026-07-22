import "dotenv/config";
import { CONFIG } from "./config.js";
import { db } from "./db/postgres.js";
import { createPaperArenaServer } from "./app.js";
import { startEscrowRecoveryWorker } from "./escrow/recovery.js";
import { recoverStuckEscrowLocks } from "./auth/escrow.service.js";
import { log } from "./log.js";

await db.connect();

// Boot: reconcile incomplete escrow only when real escrow is on.
if (!CONFIG.ESCROW.BYPASS) {
  try {
    const boot = await recoverStuckEscrowLocks({ olderThanMs: 0 });
    if (boot.scanned > 0 || boot.released > 0 || boot.reconciled > 0) {
      log.info("PaperArena", "boot escrow recovery", boot);
    }
  } catch (error) {
    log.error("PaperArena", "boot escrow recovery failed", error);
  }
}

const app = createPaperArenaServer();
const recovery = startEscrowRecoveryWorker();

app.httpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[PaperArena] listening on :${CONFIG.PORT}`);
  console.log(
    `[PaperArena] cluster=${CONFIG.RPC.SOLANA_CLUSTER} escrowBypass=${CONFIG.ESCROW.BYPASS}`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Dev/watch restarts fire SIGINT often — do a quick stop, not a full money drain.
  const quickStop = CONFIG.NODE_ENV !== "production";
  if (quickStop) {
    log.info("PaperArena", `${signal} quick stop (dev)`);
    recovery.stop();
    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
    return;
  }

  // Production: drain = no new matches, force-end live games, wait for settle, then exit.
  log.info("PaperArena", `${signal} — draining live matches (prod)`);
  recovery.stop();
  try {
    await app.drainAndClose({ settleWaitMs: CONFIG.SHUTDOWN_DRAIN_MS });
  } catch (error) {
    log.error("PaperArena", "drain failed", error);
    await app.close().catch(() => undefined);
  }
  try {
    await recoverStuckEscrowLocks({ olderThanMs: 0 });
  } catch {
    /* best effort */
  }
  await db.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
