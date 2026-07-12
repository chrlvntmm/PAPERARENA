import "dotenv/config";
import { CONFIG } from "./config.js";
import { db } from "./db/postgres.js";
import { createPaperArenaServer } from "./app.js";
import { startEscrowRecoveryWorker } from "./escrow/recovery.js";

await db.connect();

const app = createPaperArenaServer();
const recovery = startEscrowRecoveryWorker();

app.httpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[PaperArena] listening on :${CONFIG.PORT}`);
  console.log(
    `[PaperArena] escrow bypass=${CONFIG.ESCROW.BYPASS} program=${CONFIG.ESCROW.PROGRAM_ID ?? "none"}`,
  );
});

process.on("SIGTERM", () => {
  recovery.stop();
  void app.close().finally(() => {
    void db.close().finally(() => process.exit(0));
  });
});
