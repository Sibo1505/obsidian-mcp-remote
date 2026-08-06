🇩🇪 [Deutsche Version hier](docs/de/README.md)

# obsidian-mcp-remote

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude (Desktop, Code, or a
Custom Connector on Mobile/Web) read/write access to a self-hosted Obsidian vault — no need to
keep Obsidian running, no Local REST API plugin, works from any device.

## Features

- Five vault tools (`vault_read`, `vault_write`, `vault_patch`, `vault_list`, `search_query`) —
  drop-in compatible with the local Obsidian MCP setup
- Two-zone auth: a simple bearer token over your own Tailscale network, real OAuth 2.0 (PKCE,
  passkey login) for access from anywhere
- Every change lands in Git — fully revertible, no black box
- Its own network identity (Tailscale sidecar) instead of a Docker network shared with other
  services
- Push notifications on suspicious login attempts
- CI security scanning (CodeQL, gitleaks, Dependabot) active from day one

Details: [How the server works](docs/en/how-it-works.md).

## Getting started

Follow the order — each step builds on the previous one:

1. [Prerequisites & Preparation](docs/en/prerequisites.md) — what you need, what to install
   yourself beforehand
2. [Installation](docs/en/installation.md) — set up the server
3. [Verification](docs/en/verification.md) — confirm everything's running
4. [Client setup](docs/en/client-setup.md) — connect Claude Desktop/Code/Mobile

After that, it's worth reading the [security notes](docs/en/security.md) for ongoing operation.

## Development

```bash
npm install
npm test    # node:test, no external test runner
npm run build
```

## License

MIT
