# Installation

Setzt voraus, dass [Voraussetzungen & Vorbereitung](prerequisites.md) erledigt sind. Zwei Wege,
wähl was zu dir passt:

## Weg A — Geführter Wizard (empfohlen bei wenig Docker-Erfahrung)

```bash
git clone <this-repo> obsidian-mcp-remote
cd obsidian-mcp-remote
npm run wizard
```

Fragt dich interaktiv durch: Vault (Git-Remote klonen oder Pfad angeben), Tailscale Auth Key,
ob du öffentlichen Zugriff willst, generiert alle Secrets automatisch, schreibt die `.env` und
bietet an, die Container direkt zu starten und zu prüfen. Kein manuelles `.env`-Editieren nötig.

## Weg B — Komplett KI-geführt (für "ich hab wirklich keine Ahnung, mach das für mich")

Wenn du [Claude Code](https://claude.com/claude-code) nutzt: Repo klonen, Claude Code im Ordner
öffnen, `/onboard` eingeben. Führt dich durch alle vier Phasen (Vorbereitung, Installation,
Kontrolle, Client-Verbindung), erklärt jeden Schritt, und übernimmt so viel wie möglich selbst —
je nachdem, ob du Claude Code direkten Terminal-Zugriff auf deinen VPS gibst oder nicht.

## Weg C — Manuell

```bash
git clone <this-repo> obsidian-mcp-remote
cd obsidian-mcp-remote
npm run setup        # generiert .env mit starken Zufalls-Secrets
```

`npm run setup` überschreibt nie eine bestehende `.env` — `--force` anhängen, um bewusst alle
Secrets neu zu generieren.

Danach `.env` öffnen und ausfüllen:

| Variable | Wert |
|---|---|
| `VAULT_PATH` | Pfad zum Git-Checkout deines Vaults auf dem VPS (wird angelegt falls noch nicht vorhanden — siehe unten) |
| `TS_AUTHKEY` | Tailscale Auth Key, siehe unten |
| `DOMAIN` | Deine Domain (nur nötig für Mobile/Web-Zugriff) |
| `OAUTH_CLIENT_REDIRECT_URI` | Nur nötig für Custom Connector — die exakte Redirect-URI, die claude.ai beim Connector-Setup anzeigt |

**Vault-Checkout anlegen**, falls noch nicht vorhanden:
```bash
git clone <deine-vault-git-url> /pfad/aus/VAULT_PATH
```

**Tailscale Auth Key erzeugen**: `https://login.tailscale.com/admin/settings/keys` → Generate
auth key → Reusable **aus**, Ephemeral **aus** → Wert kopieren, in `TS_AUTHKEY` eintragen.

**Server starten:**
```bash
docker compose up -d tailscale   # warten bis "healthy", dann die Tailscale-IP notieren:
docker exec obsidian-mcp-remote-tailscale tailscale ip -4
docker compose up -d --build
docker exec -u root obsidian-mcp-remote chown -R appuser:appuser /vault
curl http://<tailscale-sidecar-ip>:3000/health   # -> {"status":"ok"}
```

Der `chown`-Schritt ist nötig, weil der frisch geklonte Vault-Checkout dem Host-User gehört (z.B.
`debian`), nicht `appuser` (uid 999), als der der Container läuft — ohne ihn scheitern MCP-Writes
mit `EACCES`. `npm run wizard` und `npm run verify` machen das automatisch.

**Schlüssel-Ablauf deaktivieren**: In der Tailscale-Admin-Oberfläche (`/admin/machines`) das neue
Gerät öffnen → "Disable key expiry" — sonst verliert der Container nach ein paar Monaten
unbemerkt die Verbindung, weil eine unbeaufsichtigte Neu-Authentifizierung nicht möglich ist.

**Für Mobile/Web-Zugriff** zusätzlich: siehe [Reverse-Proxy einrichten](reverse-proxy.md) — die
Tailscale-IP des Sidecars von oben ist genau das Forward-Ziel, das dort gebraucht wird. Ohne
Reverse Proxy funktioniert nur die interne Zone (Desktop/Code über Tailscale).

---
Weiter mit der [Kontrolle](verification.md).
