#!/usr/bin/env node
// Automates the manual checks from docs/de/verification.md (or docs/en/verification.md) — run after installation to confirm
// the containers are healthy, the server responds, OAuth discovery is correct (if DOMAIN is set),
// vault sync works, and the logs look clean. Exits non-zero if any check fails, so it's usable in
// scripts too, but the output is written for a human reading it directly.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, ".env");

function parseEnv(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000, ...opts });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, error };
  }
}

const results = [];
function report(label, ok, detail) {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("obsidian-mcp-remote — Kontrolle\n");

  if (!existsSync(envPath)) {
    console.error(".env nicht gefunden — erst npm run wizard oder npm run setup ausführen.");
    process.exit(1);
  }
  const env = parseEnv(readFileSync(envPath, "utf-8"));

  // 1. Containers running
  const appStatus = await run("docker", ["inspect", "obsidian-mcp-remote", "--format", "{{.State.Status}}"]);
  const tsStatus = await run("docker", ["inspect", "obsidian-mcp-remote-tailscale", "--format", "{{.State.Status}}"]);
  report(
    "Container laufen",
    appStatus.ok && appStatus.stdout === "running" && tsStatus.ok && tsStatus.stdout === "running",
    `app=${appStatus.stdout ?? "?"} tailscale=${tsStatus.stdout ?? "?"}`,
  );

  // 2. Health endpoint via the sidecar's tailnet IP
  let tailscaleIp;
  const ipResult = await run("docker", ["exec", "obsidian-mcp-remote-tailscale", "tailscale", "ip", "-4"]);
  if (ipResult.ok) {
    tailscaleIp = ipResult.stdout;
    try {
      const res = await fetch(`http://${tailscaleIp}:3000/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      report("Health-Endpoint erreichbar", res.ok && body.status === "ok", `http://${tailscaleIp}:3000/health`);
    } catch (error) {
      report("Health-Endpoint erreichbar", false, error.message);
    }
  } else {
    report("Health-Endpoint erreichbar", false, "Tailscale-IP nicht ermittelbar — Sidecar läuft nicht?");
  }

  // 3. OAuth discovery — only meaningful once a real DOMAIN is configured
  const domain = env.DOMAIN;
  if (domain && domain !== "obsidian-mcp.example.com") {
    try {
      const res = await fetch(`https://${domain}/.well-known/oauth-authorization-server`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json();
      const matches = typeof body.authorization_endpoint === "string" && body.authorization_endpoint.includes(domain);
      report("OAuth-Discovery über Domain", res.ok && matches, `https://${domain}/.well-known/oauth-authorization-server`);
    } catch (error) {
      report("OAuth-Discovery über Domain", false, error.message);
    }
  } else {
    console.log("… OAuth-Discovery übersprungen (keine DOMAIN gesetzt — nur interne Zone genutzt)");
  }

  // 4. Vault sync
  const pull = await run("docker", ["exec", "obsidian-mcp-remote", "git", "-C", "/vault", "pull"]);
  report("Vault-Sync (git pull)", pull.ok, pull.ok ? pull.stdout || "up to date" : pull.error?.message);

  // 4b. Vault beschreibbar als appuser — frische Checkouts gehören sonst dem Host-User, nicht
  // appuser (uid 999), und MCP-Writes scheitern still mit EACCES bis hierher.
  const writeTest = await run("docker", [
    "exec", "obsidian-mcp-remote", "sh", "-c",
    "f=/vault/.verify-write-test-$$; echo ok > \"$f\" && rm \"$f\"",
  ]);
  report(
    "Vault beschreibbar (appuser)",
    writeTest.ok,
    writeTest.ok ? undefined : `${writeTest.error?.message} — fix: docker exec -u root obsidian-mcp-remote chown -R appuser:appuser /vault`,
  );

  // 5. Logs look clean
  const logs = await run("docker", ["logs", "obsidian-mcp-remote", "--tail", "50"]);
  const listening = logs.ok && logs.stdout.includes("listening on port");
  const hasErrors = logs.ok && /error/i.test(logs.stdout);
  report("Logs sauber", listening && !hasErrors, hasErrors ? "'error' in den letzten 50 Zeilen gefunden" : undefined);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} Checks bestanden.`);
  if (passed < results.length) {
    console.log("Details je Check in docs/de/verification.md.");
    process.exit(1);
  }
  console.log("Weiter mit docs/de/client-setup.md.");
}

main();
