import "dotenv/config";
import { CONFIG } from "./config.js";
import { db } from "./db/postgres.js";
import { createPaperArenaServer } from "./app.js";

await db.connect();

const app = createPaperArenaServer();

app.httpServer.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[PaperArena] listening on :${CONFIG.PORT}`);
});

process.on("SIGTERM", () => {
  void app.close().finally(() => {
    void db.close().finally(() => process.exit(0));
  });
});
