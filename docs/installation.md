# Installation

Setzt voraus, dass [Voraussetzungen & Vorbereitung](prerequisites.md) erledigt sind.

> Ein geführter Installer (`npm run install`) und ein Claude-Code-Skill für die KI-geführte
> Installation sind in Arbeit und ergänzen diese Seite bald um einen zweiten, einfacheren Weg.
> Bis dahin: der manuelle Weg unten, Schritt für Schritt.

## Manueller Weg

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
curl http://<tailscale-sidecar-ip>:3000/health   # -> {"status":"ok"}
```

**Schlüssel-Ablauf deaktivieren**: In der Tailscale-Admin-Oberfläche (`/admin/machines`) das neue
Gerät öffnen → "Disable key expiry" — sonst verliert der Container nach ein paar Monaten
unbemerkt die Verbindung, weil eine unbeaufsichtigte Neu-Authentifizierung nicht möglich ist.

**Für Mobile/Web-Zugriff** zusätzlich: einen Reverse Proxy mit TLS-Zertifikat vor die Tailscale-IP
des Sidecars stellen (Forward-Ziel: `<tailscale-sidecar-ip>:3000`) und `DOMAIN` in `.env` darauf
zeigen lassen. Ohne das funktioniert nur die interne Zone (Desktop/Code über Tailscale).

---
Weiter mit der [Kontrolle](verification.md).
