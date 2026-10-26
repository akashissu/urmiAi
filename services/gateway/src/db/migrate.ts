import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

// Deliberately dumb migration runner: this schema is additive/idempotent
// (CREATE TABLE IF NOT EXISTS), so re-running it on every deploy is safe.
// A real multi-migration tool (node-pg-migrate etc.) is a reasonable upgrade
// but overkill for this assignment's scope.
async function main() {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;"); // for gen_random_uuid()
  await pool.query(sql);
  console.log("migration applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
