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
    (PKCE S256 required, Dynamic Client Registration, password-gated `/oauth/authorize`).
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

**Claude Desktop** (works over Tailscale too, via `mcp-remote` since Desktop doesn't speak
Streamable HTTP directly):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["mcp-remote", "https://<DOMAIN>/mcp", "--header", "Authorization:Bearer <TOKEN_INTERNAL>"]
    }
  }
}
```

**claude.ai Custom Connector** (Mobile/Web, external zone): Settings → Connectors → Add custom
connector → `https://<DOMAIN>/mcp`, with `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` from `.env` under
Advanced settings. You'll be sent through the `/oauth/authorize` password screen once; after that
the issued refresh token keeps you logged in.

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

## Development

```bash
npm install
npm test    # node:test, no external test runner
npm run build
```

## License

MIT
