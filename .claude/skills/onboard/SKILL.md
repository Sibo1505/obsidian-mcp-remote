---
name: onboard
description: Guides a self-hoster through installing obsidian-mcp-remote end to end — prerequisites, installation, verification, and client setup — doing as much of the work as possible via Bash while explaining each step in plain language.
---

# Onboarding: obsidian-mcp-remote self-hosting

You are helping someone install and configure `obsidian-mcp-remote` on their own VPS. Assume they
may have little or no Docker/Tailscale experience — that's the whole point of this skill existing
instead of just pointing them at the docs. Explain what you're doing and why at each step, not
just the raw commands.

Read `docs/prerequisites.md`, `docs/installation.md`, `docs/verification.md`, and
`docs/client-setup.md` in this repo first if you haven't already this session — they're the
canonical source of truth for every step below. This skill is a guided wrapper around them, not a
replacement; if anything here and those docs disagree, the docs win (they may have been updated
since this skill was written).

## Ground rules

- **Confirm before anything that touches their VPS or their vault's git history.** You likely
  don't have direct SSH access to their VPS — most of the time you'll be giving them exact
  commands to run and reading back the output, the same pattern as a real pair-programming
  session. If you *do* have Bash access to a shell that's already on their VPS, still narrate what
  you're about to run before running it.
- **Never invent secrets or paste them into chat unnecessarily.** Prefer having the user generate
  Tailscale auth keys themselves in the Tailscale admin console and paste just the value back, the
  same way `scripts/install-wizard.mjs` does it.
- **One phase at a time.** Don't jump ahead to client setup while prerequisites are still unmet —
  confirm each phase actually succeeded before moving on.
- If something fails, diagnose from the actual error output before suggesting a fix — don't guess.

## Phase 1 — Prerequisites

Ask what they already have running on their VPS (clean box vs. already hosting other things).
Walk through `docs/prerequisites.md`'s checklist conversationally: Docker, a git remote for their
vault (Gitea/GitHub/GitLab — help them figure out which if they're unsure), Tailscale, and
optionally a reverse proxy with TLS if they want Mobile/Web access. Don't move to Phase 2 until
Docker and Tailscale are confirmed working (`docker --version`, `tailscale status`).

## Phase 2 — Installation

Two ways to actually do this, pick based on what you have access to:

- **If you can run commands on their VPS directly** (they've given you a shell there): run
  `npm run wizard` yourself and relay its prompts/output — it already handles vault cloning,
  Tailscale key entry, secret generation, and starting the containers. Read its source
  (`scripts/install-wizard.mjs`) if you want to know exactly what it's doing before running it.
- **If you're only exchanging commands/output with them** (no direct shell access to their VPS):
  walk them through `npm run wizard` themselves, one prompt at a time, explaining each question as
  it comes up. Don't just paste the whole command sequence from `docs/installation.md`'s manual
  path unless they explicitly prefer that over the interactive wizard.

Either way, the redirect URI for the Custom Connector (`OAUTH_CLIENT_REDIRECT_URI`) can't be filled
in yet at this point — that only becomes known during Phase 4. Don't block on it now.

## Phase 3 — Verification

Run `npm run verify` (or walk them through running it). It checks container health, the `/health`
endpoint, OAuth discovery (if a real domain is configured), vault sync, and the logs — and tells
you exactly which of the five failed. For a failure:

- **Container not running:** `docker logs obsidian-mcp-remote --tail 50` and
  `docker logs obsidian-mcp-remote-tailscale --tail 50` — usually a bad `TS_AUTHKEY` or a
  `docker compose up -d --build` that never ran.
- **Health endpoint unreachable:** confirm the Tailscale sidecar actually has an IP
  (`docker exec obsidian-mcp-remote-tailscale tailscale ip -4`) before assuming the app itself is
  broken.
- **OAuth discovery failing:** almost always the reverse proxy's forward target pointing at the
  wrong IP/port, or DNS not yet propagated for a freshly added domain.
- **Vault sync failing:** check the git remote URL and credentials
  (`docker exec obsidian-mcp-remote git -C /vault remote -v`).

Don't proceed to Phase 4 until all five checks pass.

## Phase 4 — Client setup

Ask which clients they actually want (Claude Code, Desktop, Mobile/Web Custom Connector — they
don't need all three). Walk through `docs/client-setup.md` for whichever they pick. For the
Custom Connector specifically: they need to start adding it in claude.ai *first* to see the exact
redirect URI it expects, put that into `OAUTH_CLIENT_REDIRECT_URI` in `.env`, then
`docker compose up -d --build` to pick up the change, *then* finish adding the connector.

Mention the [Passkey login](../../../docs/client-setup.md) setup as a strong recommendation once at
least one client is connected — it's a five-minute step that removes the password as a phishing
target.

## Done

Point them at `docs/security.md` for ongoing operational hygiene (secret rotation, `NTFY_TOPIC`
for alerts, what the accepted-risk items mean) — not required to finish, but worth reading once.
