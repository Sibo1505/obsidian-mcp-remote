# Client setup

Assumes a successful [Verification](verification.md). Three clients, depending on what you use —
all three can be set up in parallel.

## Claude Code / anything that accepts a static bearer token
Internal zone, over Tailscale — no OAuth needed:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://<tailscale-sidecar-ip>:3000/mcp",
      "headers": { "Authorization": "Bearer <TOKEN_INTERNAL from .env>" }
    }
  }
}
```

## Claude Desktop
Goes through `mcp-remote`, since Desktop doesn't speak Streamable HTTP directly:

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

`--header`-only auth doesn't work here — `mcp-remote` always runs its OAuth discovery flow
regardless of flags. Desktop therefore goes through the external/OAuth zone, not
`TOKEN_INTERNAL`. On first connection, a browser opens to `/oauth/authorize` — log in there with a
passkey (if registered) or the password. The issued refresh token keeps you logged in across
restarts.

## claude.ai Custom Connector (Mobile/Web)
External zone, needs `DOMAIN`:

Settings → Connectors → Add custom connector → `https://<DOMAIN>/mcp`, under "Advanced settings"
enter `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` from `.env`. Same `/oauth/authorize` login as
Desktop above.

## Register a passkey (recommended for any external connection)

1. Open `https://<DOMAIN>/webauthn/setup`
2. Enter `OAUTH_PASSWORD`, then follow the browser's prompt for the passkey (Windows Hello,
   fingerprint sensor, hardware key)
3. From now on `/oauth/authorize` shows a passkey login button, the password stays as a fallback

Only one passkey is stored at a time (single-user tool) — a new one replaces the old one. Needs
the real public HTTPS `DOMAIN`, doesn't work against a raw Tailscale IP or plain HTTP.

---
Done — see [How it works](how-it-works.md) for details on how it all fits together, or
[security notes](security.md) for ongoing operation.
