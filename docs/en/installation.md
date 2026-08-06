# Installation

Assumes [Prerequisites & Preparation](prerequisites.md) is done. Three ways, pick what fits you:

## Way A — Guided wizard (recommended if you're new to Docker)

```bash
git clone <this-repo> obsidian-mcp-remote
cd obsidian-mcp-remote
npm run wizard
```

Interactively asks you through: vault (clone a git remote or point at a path), Tailscale auth key,
whether you want public access, generates all secrets automatically, writes `.env`, and offers to
start and check the containers itself. No manual `.env` editing needed.

## Way B — Fully AI-guided (for "I really have no idea, do it for me")

If you use [Claude Code](https://claude.com/claude-code): clone the repo, open Claude Code in the
folder, type `/onboard`. Walks you through all four phases (preparation, installation,
verification, client setup), explains each step, and takes over as much as possible itself —
depending on whether you give Claude Code direct terminal access to your VPS or not.

## Way C — Manual

```bash
git clone <this-repo> obsidian-mcp-remote
cd obsidian-mcp-remote
npm run setup        # generates .env with strong random secrets
```

`npm run setup` never overwrites an existing `.env` — pass `--force` to deliberately regenerate
every secret.

Then open `.env` and fill in:

| Variable | Value |
|---|---|
| `VAULT_PATH` | Path to your vault's git checkout on the VPS (created if it doesn't exist yet — see below) |
| `TS_AUTHKEY` | Tailscale auth key, see below |
| `DOMAIN` | Your domain (only needed for Mobile/Web access) |
| `OAUTH_CLIENT_REDIRECT_URI` | Only needed for the Custom Connector — the exact redirect URI claude.ai shows during connector setup |

**Create the vault checkout**, if it doesn't exist yet:
```bash
git clone <your-vault-git-url> /path/from/VAULT_PATH
```

**Generate a Tailscale auth key**: `https://login.tailscale.com/admin/settings/keys` → Generate
auth key → Reusable **off**, Ephemeral **off** → copy the value into `TS_AUTHKEY`.

**Start the server:**
```bash
docker compose up -d tailscale   # wait until "healthy", then note its Tailscale IP:
docker exec obsidian-mcp-remote-tailscale tailscale ip -4
docker compose up -d --build
curl http://<tailscale-sidecar-ip>:3000/health   # -> {"status":"ok"}
```

**Disable key expiry**: In the Tailscale admin console (`/admin/machines`), open the new device →
"Disable key expiry" — otherwise the container silently loses its connection after a few months,
since an unattended re-authentication isn't possible.

**For Mobile/Web access** additionally: put a reverse proxy with a TLS certificate in front of the
sidecar's Tailscale IP (forward target: `<tailscale-sidecar-ip>:3000`) and point `DOMAIN` in
`.env` at it. Without that, only the internal zone (Desktop/Code over Tailscale) works.

---
Continue with [Verification](verification.md).
