import { Pool } from "pg";

export const pool = new Pool({
  connectionString: required("DATABASE_URL"),
  max: 10,
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
