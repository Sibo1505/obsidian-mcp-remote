#!/usr/bin/env node
// Generates a .env with strong random secrets instead of asking self-hosters to invent their
// own — the #1 way self-hosted instances end up weak is a human picking "password123".
// Uses only Node core modules so it runs right after `git clone`, before `npm install`.
// No interactive prompts: readline/promises has a known hang/crash on non-TTY stdin (Node 20,
// exit code 13) which would break this in CI, Docker build steps, or piped invocations — the
// host-specific values (paths, IPs, domain) are left as clearly marked placeholders instead.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envExamplePath = path.join(root, ".env.example");
const envPath = path.join(root, ".env");

if (existsSync(envPath) && !process.argv.includes("--force")) {
  console.error(".env already exists — refusing to overwrite it. Pass --force to regenerate secrets anyway.");
  process.exit(1);
}

const GENERATORS = {
  TOKEN_INTERNAL: () => randomBytes(32).toString("hex"),
  OAUTH_PASSWORD: () => randomBytes(24).toString("base64"),
  OAUTH_CLIENT_ID: () => randomBytes(16).toString("hex"),
  OAUTH_CLIENT_SECRET: () => randomBytes(32).toString("hex"),
};

// Everything else in .env.example is host-specific (paths, IPs, domain) — a script can't
// meaningfully generate those, so they're left as the documented placeholders for manual editing.
const STILL_TO_FILL_IN = ["VAULT_PATH", "TS_AUTHKEY", "DOMAIN", "OAUTH_CLIENT_REDIRECT_URI"];

let output = readFileSync(envExamplePath, "utf-8");
for (const [key, generate] of Object.entries(GENERATORS)) {
  output = output.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${generate()}`);
}

writeFileSync(envPath, output, "utf-8");
console.log(`Wrote ${envPath} with freshly generated secrets for: ${Object.keys(GENERATORS).join(", ")}.\n`);
console.log("Still needs your input — edit .env and fill in:");
for (const key of STILL_TO_FILL_IN) {
  console.log(`  - ${key}`);
}
console.log("\nThen:");
console.log("  1. docker compose up -d tailscale   (wait for it to report healthy, then find its tailnet IP)");
console.log("  2. docker compose up -d --build");
console.log('  3. curl http://<tailscale-sidecar-ip>:3000/health   ->  {"status":"ok"}');
