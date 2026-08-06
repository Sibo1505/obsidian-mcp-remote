# How the server works

## The five tools

Identical to the local Obsidian MCP setup, drop-in compatible:

| Tool | Does |
|---|---|
| `vault_read` | Read a note, optionally just one heading/block from it |
| `vault_write` | Write a note in full (new or overwrite) |
| `vault_patch` | Change a specific section/heading of an existing note |
| `vault_list` | List a folder's contents |
| `search_query` | Search the vault — JsonLogic queries over frontmatter, content, wikilinks |

## Two-zone auth model

The server distinguishes where a request comes from and demands proportionally stronger proof:

- **Internal** (your Tailscale network — Claude Desktop directly, Claude Code): a static bearer
  token (`TOKEN_INTERNAL`). Sufficient because Tailscale itself is already an encrypted,
  authenticated connection — the token just adds protection against anyone else on your tailnet
  using the server, not only you.
- **External** (public internet — Mobile/Web Custom Connector): a real OAuth 2.0 server with PKCE
  (S256 mandatory), login via passkey or password. Needed because claude.ai connects from its own
  cloud, not from your tailnet — Tailscale alone isn't reachable from there.

An important detail: a leaked `TOKEN_INTERNAL` does **not** work from outside your tailnet — the
server additionally checks on every request whether it actually originates from Tailscale's
address range (`combinedAuth`). The two zones aren't just separated by different tokens, but by an
actual network-level check.

## Git as a safety net

Every change is a plain file write in the vault checkout, followed by an automatic `git commit` +
`push`. Nothing gets "lost" — every change is revertible through normal Git history (`git revert`,
or directly in the Gitea/GitHub UI), same as any other repo.

Before every read, the server also does a `git pull`, so you see the current version even if the
note was just changed from another device. On a real conflict (two devices changing the same note
at once), the newer version lands in a `<name>.claude-conflict.<timestamp>.md` file instead of
blocking the sync — you decide what to keep.

## Network isolation

The server runs with its **own Tailscale identity** (a `tailscale` sidecar container in
`docker-compose.yml`) instead of sharing a Docker network with an existing reverse proxy or other
services on your VPS. Reason: if you make the server publicly reachable (for Mobile/Web), it's the
one component on your VPS that's actually reachable from the internet — its own network identity
means a compromise of just this one container doesn't open a direct path to whatever else is
running in your Docker network (Gitea, databases, admin dashboards, anything else you host).

In practice: your reverse proxy doesn't forward to a Docker container name, but to the sidecar's
own Tailscale IP — like any other device on your tailnet.

## Passkey login

`/oauth/authorize` accepts a WebAuthn passkey (Windows Hello, a fingerprint sensor, a hardware
security key) instead of a password — not phishable the way a password is, usually faster. Set up
once at `https://<DOMAIN>/webauthn/setup` (unlocked with `OAUTH_PASSWORD`), after which the login
screen shows a passkey button; the password stays as a fallback.

## Push notifications

Optional (`NTFY_TOPIC` in `.env`): a push notification via [ntfy.sh](https://ntfy.sh) on every
wrong login attempt or triggered rate limit — so an attempted attack doesn't go unnoticed without
you having to dig through logs.

---
Continue with [security notes](security.md), or go straight to [Installation](installation.md).
