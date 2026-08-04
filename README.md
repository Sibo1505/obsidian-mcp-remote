# obsidian-mcp-remote

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude (Desktop, Code, or a
Custom Connector) read/write access to a self-hosted Obsidian vault — no need to keep Obsidian
running, no Local REST API plugin, works from any device.

Exposes the same five tools as the local Obsidian MCP setup: `vault_read`, `vault_write`,
`vault_patch`, `vault_list`, `search_query` — drop-in compatible.

## How it works

- The vault is a plain Git checkout on your VPS (e.g. auto-pulled from a private Gitea/GitHub repo).
- This server mounts that checkout read-write and speaks MCP over HTTP.
- Two auth zones, so you don't need OAuth just to use it from your own machine over Tailscale:
  - **Internal** (Tailscale network — Desktop-direct, Claude Code): a static bearer token.
  - **External** (public internet — Mobile/Web Custom Connectors): a real OAuth 2.0 server
    (PKCE S256 required, Dynamic Client Registration, `/oauth/authorize` gated by a passkey or
    password).
- Git is your rollback net: every write is a plain file write, revertable via `git revert` on the
  vault repo like any other change.

## Quickstart

Requirements: Docker, a domain (only needed for the external/OAuth zone), a Tailscale network
(only needed for the internal zone).

```bash
git clone <this-repo> obsidian-mcp-remote
cd obsidian-mcp-remote
npm run setup        # generates .env with strong random secrets
# edit .env: fill in VAULT_PATH, TAILSCALE_IP, HOST_PORT, DOMAIN, OAUTH_CLIENT_REDIRECT_URI
docker compose up -d --build
curl http://<TAILSCALE_IP>:<HOST_PORT>/health   # -> {"status":"ok"}
```

`npm run setup` never overwrites an existing `.env` — pass `--force` if you deliberately want to
rotate every generated secret.

For the external/OAuth zone to be reachable from claude.ai (Mobile/Web) or over plain internet,
put a reverse proxy with a real TLS certificate in front of `HOST_PORT` (e.g. Nginx Proxy Manager
+ Let's Encrypt) and point `DOMAIN` at it. The internal/Tailscale zone works without any of that.

## Connecting a client

**Claude Code / anything that accepts a static bearer token** (internal zone, over Tailscale):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://<TAILSCALE_IP>:<HOST_PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN_INTERNAL from .env>" }
    }
  }
}
```

**Claude Desktop** (via `mcp-remote`, since Desktop doesn't speak Streamable HTTP directly):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["mcp-remote@latest", "https://<DOMAIN>/mcp"]
    }
  }
}
```

`--header`-only auth doesn't work here: `mcp-remote` always runs its OAuth discovery flow
regardless of flags, so Desktop goes through the external/OAuth zone (below), not `TOKEN_INTERNAL`.
First connection opens a browser to `/oauth/authorize` — log in with a passkey (if registered) or
the password. The issued refresh token keeps you logged in across restarts (see Passkey section).

**claude.ai Custom Connector** (Mobile/Web, external zone): Settings → Connectors → Add custom
connector → `https://<DOMAIN>/mcp`, with `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` from `.env` under
Advanced settings. Same `/oauth/authorize` login as Desktop above.

## Passkey login (recommended)

`/oauth/authorize` accepts a WebAuthn passkey (Windows Hello, a phone's fingerprint sensor, a
hardware security key) instead of typing the password — not phishable the way a password is, and
usually faster. Register one once:

1. Visit `https://<DOMAIN>/webauthn/setup`.
2. Enter `OAUTH_PASSWORD` to authorize the registration, then follow the browser's passkey prompt.
3. From then on, `/oauth/authorize` shows a "Mit Passkey anmelden" button. The password field stays
   as a fallback if the passkey device isn't available.

Only one passkey is stored at a time (single-user tool) — registering a new one replaces the old
one. Requires the real public HTTPS `DOMAIN`; won't work against a raw Tailscale IP or plain HTTP.

## Security notes

- **Never commit `.env`** — it's already in `.gitignore`, only `.env.example` is tracked.
- **Rotate secrets periodically** (`npm run setup --force` + restart), especially after sharing
  your screen, pasting a token into a chat, or any other accidental exposure.
- The OAuth password (`OAUTH_PASSWORD`) is the only gate on the public `/oauth/authorize`
  endpoint — rate-limited, but still a single factor. Use a long random value (the setup script
  generates one; don't replace it with something memorable).
- `TOKEN_INTERNAL` is scoped to the Tailscale network by the `docker-compose.yml` port binding
  (`${TAILSCALE_IP}:${HOST_PORT}:3000`, never `0.0.0.0`) — don't change that binding without
  understanding you'd be exposing the internal token to the public internet.
- Read/write access means a leaked token lets someone read your whole vault, not just write to
  it. Git history protects against destructive edits, not against exfiltration.
- Set `NTFY_TOPIC` in `.env` to get a push notification (via [ntfy.sh](https://ntfy.sh), no
  account needed) whenever the rate limiter trips or a login attempt fails — otherwise you won't
  know someone's probing the endpoint. Pick an unguessable topic name; treat it like a secret.
- Dependabot is enabled on this repo (`.github/dependabot.yml`) for npm and Docker base image
  updates.

## Development

```bash
npm install
npm test    # node:test, no external test runner
npm run build
```

## License

MIT
