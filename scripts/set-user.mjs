#!/usr/bin/env node
// Create or replace the single app user: node scripts/set-user.mjs <username> <password>
// Writes data/auth.json (or $NEXORA_DATA_DIR/auth.json). Same format as src/lib/auth.ts.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("usage: node scripts/set-user.mjs <username> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}
const dataDir = process.env.NEXORA_DATA_DIR ?? path.join(process.cwd(), "data");
const file = path.join(dataDir, "auth.json");
let existing = null;
try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const N = 16384;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N });
const cfg = {
  username: username.trim(),
  passwordHash: `scrypt$${N}$${salt.toString("hex")}$${hash.toString("hex")}`,
  sessionSecret: existing?.sessionSecret ?? randomBytes(32).toString("hex"),
  updatedAt: new Date().toISOString(),
};
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`user "${cfg.username}" saved to ${file}`);
