# Prerequisites & Preparation

Two phases before the actual installation starts. You do both yourself — they depend too much on
your specific VPS/provider to automate sensibly.

## Phase 1 — What you need

- **A VPS** with Docker support. Debian/Ubuntu recommended (what this project is tested on), other
  Linux distributions work too as long as Docker runs.
- **A git remote for your vault** — Gitea, GitHub, GitLab, any provider. The server needs
  somewhere to `git pull`/`git push` from. If you don't have one yet: a private repo on
  [Gitea](https://gitea.com) (self-hosted) or [GitHub](https://github.com) (private repo, free)
  works fine.
- **A Claude account** with access to [Custom Connectors](https://claude.ai) (Settings →
  Connectors), if you also want to use the server from Claude Mobile/Web. A regular account is
  enough for Claude Desktop/Code.
- **Optional: your own domain**, if you want access from outside your home network (Mobile/Web,
  without VPN). The server still works without one — just limited to your Tailscale network
  (Desktop/Code).

## Phase 2 — What to install beforehand

Order doesn't matter, but all four should be in place before you move on to
[Installation](installation.md). If your VPS already has Docker/Tailscale/etc. running (e.g.
because you're already hosting other things there), just skip what's already there.

| What | For | Guide |
|---|---|---|
| **Docker + Docker Compose** | The server itself runs as a container | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) |
| **Tailscale** (recommended) | Secure internal access (Desktop/Code) without public exposure, and the server later gets its own identity on the tailnet | [tailscale.com/download](https://tailscale.com/download) — create an account, run `tailscale up` on the VPS |
| **A reverse proxy with TLS** (only needed for Mobile/Web) | Terminates HTTPS, forwards to the server | See [Reverse proxy setup](reverse-proxy.md) — install the software now, configure the actual proxy host during Installation |
| **Git** on the VPS host | Not strictly required (the server does its git operations inside the container), but handy for debugging | Usually already installed (`git --version` to check) |
| **Node.js 20+** on the VPS host (only for `npm run wizard`/`verify`/`setup`) | The server itself is fully containerized and never needs Node on the host — but the setup tooling in [Installation](installation.md) Way A/C does, since it's plain `.mjs` scripts run directly, not inside Docker. Skip this if you're only using Way B (the `/onboard` Claude Code skill) or writing `.env` by hand. | [nodejs.org](https://nodejs.org/en/download) or your distro's package manager |

**Starting from a clean VPS:** Start with Docker (`curl -fsSL https://get.docker.com | sh`), then
Tailscale, then optionally the reverse proxy. No Gitea needed if you use a private GitHub repo for
the vault instead.

**Already running other services on your VPS:** When setting up the reverse proxy, make sure the
new server doesn't accidentally expose other services along with it — see the networking notes in
[How it works](how-it-works.md#network-isolation).

Done? Continue with [Installation](installation.md).
