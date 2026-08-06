#!/usr/bin/env node
// Interactive onboarding for people with little/no Docker/Tailscale experience — walks through
// vault setup, Tailscale auth, secret generation and (optionally) starting the containers, then
// verifies the result. Meant to be run directly in a real terminal (not CI/piped), so unlike
// setup.mjs it's fine to use interactive prompts here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envExamplePath = path.join(root, ".env.example");
const envPath = path.join(root, ".env");

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(question, { defaultValue } = {}) {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = (await rl.question(`${question}${suffix} > `)).trim();
  return answer || defaultValue || "";
}
async function askYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${suffix}] > `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}
function section(title) {
  console.log(`\n${"─".repeat(60)}\n${title}\n${"─".repeat(60)}`);
}
async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, opts);
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function main() {
  console.log("obsidian-mcp-remote — geführtes Setup\n");
  console.log("Setzt voraus, dass Docker und (empfohlen) Tailscale auf diesem Rechner schon");
  console.log("installiert sind — siehe docs/de/prerequisites.md falls noch nicht.\n");

  if (existsSync(envPath)) {
    const overwrite = await askYesNo(
      ".env existiert bereits. Trotzdem fortfahren und überschreiben?",
      false,
    );
    if (!overwrite) {
      console.log("Abgebrochen — bestehende .env bleibt unverändert.");
      rl.close();
      return;
    }
  }

  // --- Vault ---
  section("1/5 — Vault");
  let vaultPath;
  const hasRemote = await askYesNo("Hast du schon einen Git-Remote für deinen Vault (Gitea/GitHub/GitLab)?");
  if (hasRemote) {
    const remoteUrl = await ask("Git-Remote-URL deines Vaults");
    vaultPath = await ask("Wohin auf diesem Rechner klonen?", { defaultValue: path.join(root, "vault-data") });
    console.log(`\nKlone ${remoteUrl} nach ${vaultPath} ...`);
    const result = await run("git", ["clone", remoteUrl, vaultPath]);
    if (result.ok) {
      console.log("✓ Vault geklont.");
    } else {
      console.log("✗ Klonen fehlgeschlagen — häufigste Ursache: falsche URL oder fehlende Zugangsdaten.");
      console.log(`  Fehler: ${result.error.message}`);
      console.log(`  Du kannst das später manuell nachholen: git clone ${remoteUrl} ${vaultPath}`);
    }
  } else {
    console.log("\nKein Problem — dafür brauchst du zuerst ein leeres privates Repo bei Gitea oder");
    console.log("GitHub, und musst deinen lokalen Vault-Ordner (auf DEINEM Rechner, nicht hier auf");
    console.log("dem VPS) einmal dorthin pushen:");
    console.log("  cd /pfad/zu/deinem/vault");
    console.log("  git init && git add -A && git commit -m 'initial'");
    console.log("  git remote add origin <deine-neue-repo-url>");
    console.log("  git push -u origin main");
    console.log("\nDanach diesen Wizard erneut starten, dann mit 'ja' antworten.");
    vaultPath = await ask("Pfad, unter dem der Vault-Checkout später liegen soll", {
      defaultValue: path.join(root, "vault-data"),
    });
  }

  // --- Tailscale ---
  section("2/5 — Tailscale");
  const tsStatus = await run("tailscale", ["status"]);
  if (tsStatus.ok) {
    console.log("✓ Tailscale ist installiert und aktiv auf diesem Rechner.");
  } else {
    console.log("⚠ Konnte 'tailscale status' nicht ausführen — ist Tailscale installiert und");
    console.log("  eingeloggt? Falls nicht: https://tailscale.com/download, dann 'tailscale up'.");
    console.log("  Der Wizard läuft trotzdem weiter, der Server startet aber erst wenn das steht.");
  }
  console.log("\nAuth Key erzeugen: https://login.tailscale.com/admin/settings/keys");
  console.log("→ Generate auth key → Reusable AUS, Ephemeral AUS → Wert kopieren.");
  const tsAuthKey = await ask("Tailscale Auth Key einfügen");

  // --- Domain ---
  section("3/5 — Öffentlicher Zugriff (Mobile/Web)");
  const wantsPublic = await askYesNo(
    "Willst du jetzt schon öffentlichen Zugriff einrichten (für Claude Mobile/Web)?",
    false,
  );
  let domain = "obsidian-mcp.example.com";
  if (wantsPublic) {
    console.log("\nBraucht einen Reverse Proxy mit TLS vor der Tailscale-IP des Servers — siehe");
    console.log("docs/de/reverse-proxy.md, falls der noch nicht steht.");
    domain = await ask("Deine Domain (z.B. obsidian-mcp.deine-domain.dev)", { defaultValue: domain });
  } else {
    console.log("Übersprungen — DOMAIN bleibt ein Platzhalter, du kannst das jederzeit nachtragen.");
  }

  // --- Secrets ---
  section("4/5 — Secrets");
  const secrets = {
    TOKEN_INTERNAL: randomBytes(32).toString("hex"),
    OAUTH_PASSWORD: randomBytes(24).toString("base64"),
    OAUTH_CLIENT_ID: randomBytes(16).toString("hex"),
    OAUTH_CLIENT_SECRET: randomBytes(32).toString("hex"),
  };
  console.log("✓ TOKEN_INTERNAL, OAUTH_PASSWORD, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET generiert.");
  let ntfyTopic = "";
  if (await askYesNo("Push-Benachrichtigungen bei fehlgeschlagenen Logins einrichten (ntfy.sh)?")) {
    ntfyTopic = randomBytes(16).toString("hex");
    console.log(`✓ Zufälliges Topic generiert: ${ntfyTopic}`);
    console.log(`  Zum Abonnieren: ntfy-App → Topic "${ntfyTopic}", Server ntfy.sh (Standard).`);
  }

  // --- Write .env ---
  section("5/5 — .env schreiben");
  let output = readFileSync(envExamplePath, "utf-8");
  const values = {
    VAULT_PATH: vaultPath,
    TS_AUTHKEY: tsAuthKey || "tskey-auth-changeme",
    DOMAIN: domain,
    ...secrets,
    NTFY_TOPIC: ntfyTopic,
  };
  for (const [key, value] of Object.entries(values)) {
    output = output.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
  }
  writeFileSync(envPath, output, "utf-8");
  console.log(`✓ ${envPath} geschrieben.`);
  console.log("  OAUTH_CLIENT_REDIRECT_URI bleibt offen — die trägst du erst beim Einrichten des");
  console.log("  Custom Connectors in claude.ai ein (siehe docs/de/client-setup.md).");

  // --- Optionally start ---
  const startNow = await askYesNo("\nContainer jetzt starten?");
  if (startNow) {
    console.log("\nStarte Tailscale-Sidecar ...");
    const tsUp = await run("docker", ["compose", "up", "-d", "tailscale"], { cwd: root });
    if (!tsUp.ok) {
      console.log(`✗ Fehlgeschlagen: ${tsUp.error.message}`);
      console.log("  Manuell nachholen: docker compose up -d tailscale");
    } else {
      console.log("✓ Gestartet. Warte kurz, bis Tailscale eine IP hat ...");
      await new Promise((r) => setTimeout(r, 8000));
      const ip = await run("docker", ["exec", "obsidian-mcp-remote-tailscale", "tailscale", "ip", "-4"]);
      if (ip.ok) {
        console.log(`✓ Tailscale-IP: ${ip.stdout}`);
        console.log("\nStarte den Server ...");
        const appUp = await run("docker", ["compose", "up", "-d", "--build"], { cwd: root });
        if (appUp.ok) {
          console.log("✓ Server gestartet.");
          const health = await run("curl", ["-sf", `http://${ip.stdout}:3000/health`]);
          console.log(health.ok ? `✓ Health-Check: ${health.stdout}` : "⚠ Health-Check noch nicht erreichbar — kurz warten und docs/de/verification.md durchgehen.");
        } else {
          console.log(`✗ Serverstart fehlgeschlagen: ${appUp.error.message}`);
        }
      } else {
        console.log("⚠ Tailscale noch nicht bereit (Auth Key falsch/abgelaufen?). Logs prüfen:");
        console.log("  docker logs obsidian-mcp-remote-tailscale --tail 20");
      }
    }
  } else {
    console.log("\nÜbersprungen. Manuell starten laut docs/de/installation.md.");
  }

  console.log("\nWeiter mit docs/de/verification.md, dann docs/de/client-setup.md.");
  rl.close();
}

main().catch((error) => {
  console.error("\nUnerwarteter Fehler:", error.message);
  rl.close();
  process.exit(1);
});
