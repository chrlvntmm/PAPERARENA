import "dotenv/config";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { CONFIG } from "../config.js";

const { Client } = pg;

const client = new Client({
  connectionString: CONFIG.DATABASE_URL,
  ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: CONFIG.DATABASE_SSL_REJECT_UNAUTHORIZED } : undefined,
  connectionTimeoutMillis: CONFIG.DATABASE_CONNECTION_TIMEOUT_MS,
});

try {
  await client.connect();
  const migrationsDir = join(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const migrationPath = join(migrationsDir, file);
    const sql = await readFile(migrationPath, "utf8");
    await client.query(sql);
    console.log(`Applied migration: ${file}`);
  }
} finally {
  await client.end();
}
