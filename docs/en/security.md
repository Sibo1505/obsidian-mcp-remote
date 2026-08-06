# Security notes

- **Never commit `.env`** — already in `.gitignore`, only `.env.example` is tracked in the repo.
- **Rotate secrets periodically** (`npm run setup -- --force` + restart), especially after screen
  sharing, an accidentally posted token in a chat, or any other unwanted exposure.
- `OAUTH_PASSWORD` is the only factor on the public `/oauth/authorize` endpoint if you don't
  register a passkey — rate-limited, but still a single factor. Use the long random value the
  setup script generates, not something memorable. A registered passkey (see
  [How it works](how-it-works.md#passkey-login)) is considerably stronger.
- `TOKEN_INTERNAL` is scoped to your Tailscale network twice over: the container only ever has a
  tailnet IP in the first place (via the `tailscale` sidecar, never `0.0.0.0`), and the server
  additionally checks the source IP of every request against Tailscale's address range — a leaked
  token doesn't work from outside.
- Read/write access means a leaked token also allows reading the entire vault, not just writing.
  Git history protects against destructive edits, not against exfiltration.
- Set `NTFY_TOPIC` in `.env` for push notifications on rate-limit hits and failed logins (see
  [How it works](how-it-works.md#push-notifications)) — otherwise you won't notice someone probing
  the endpoint.
- This repo has Dependabot (`.github/dependabot.yml`, npm + Docker base image) as well as CodeQL
  and gitleaks as GitHub Actions (`.github/workflows/`) active — run on every push/PR, CodeQL also
  weekly. If you fork it, enable these workflows in your own repo too.
- Dynamic Client Registration (`POST /register`) does **not** exist anymore — the endpoint was
  removed because it was unauthenticated public attack surface with no real use (the Custom
  Connector flow exclusively uses the preregistered client from `.env`). If you connect Desktop
  via `mcp-remote`: that also uses the preregistered client, no separate registration needed.
- Registered clients and issued tokens live as plain JSON (`OAUTH_STORE_PATH`), not encrypted at
  rest. Accepted risk for this threat model (your VPS already holds `.env` in the clear) — but
  relevant if you ever back up or move that volume: treat it like any other secrets file.
- `npm run oauth:list` / `npm run oauth:revoke -- <client_id>` show or revoke registered
  clients/tokens — the only way to review or undo a granted consent without an admin UI. Needs a
  container restart to take effect.
- Rate limiting is in-memory per process and doesn't survive a container restart — acceptable for
  a single-container deployment, but not a guaranteed protection across a redeploy.
- The server runs with its own Tailscale identity instead of sharing a Docker network with other
  services on your VPS — details under
  [Network isolation](how-it-works.md#network-isolation). If you run additional services of your
  own in the same Docker network as a reverse proxy, make sure the new public-facing container
  doesn't get pulled into it.

---
Continue with [Installation](installation.md).
