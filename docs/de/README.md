🇬🇧 [English version here](../../README.md)

# obsidian-mcp-remote

Ein remote [MCP](https://modelcontextprotocol.io)-Server, der Claude (Desktop, Code, oder ein
Custom Connector auf Mobile/Web) Lese-/Schreibzugriff auf einen selbst gehosteten Obsidian-Vault
gibt — kein laufendes Obsidian nötig, kein Local-REST-API-Plugin, funktioniert von jedem Gerät aus.

## Features

- Fünf Vault-Tools (`vault_read`, `vault_write`, `vault_patch`, `vault_list`, `search_query`) —
  drop-in-kompatibel zum lokalen Obsidian-MCP-Setup
- Zwei-Zonen-Auth: einfacher Bearer-Token über dein eigenes Tailscale-Netz, echtes OAuth 2.0
  (PKCE, Passkey-Login) für Zugriff von überall
- Jede Änderung landet in Git — voll revertierbar, keine Blackbox
- Eigene Netzwerk-Identität (Tailscale-Sidecar) statt geteiltem Docker-Netz mit anderen Diensten
- Push-Benachrichtigungen bei verdächtigen Login-Versuchen
- CI-Security-Scanning (CodeQL, gitleaks, Dependabot) von Anfang an aktiv

Details dazu: [Wie der Server funktioniert](how-it-works.md).

## Los geht's

Reihenfolge einhalten — jeder Schritt baut auf dem vorherigen auf:

1. [Voraussetzungen & Vorbereitung](prerequisites.md) — was du brauchst, was du vorher
   selbst installierst
2. [Installation](installation.md) — den Server aufsetzen
3. [Kontrolle](verification.md) — prüfen, dass alles läuft
4. [Client-Verbindung](client-setup.md) — Claude Desktop/Code/Mobile anbinden

Danach lohnt sich ein Blick in die [Sicherheitshinweise](security.md) für den laufenden Betrieb.

## Development

```bash
npm install
npm test    # node:test, kein externer Test-Runner
npm run build
```

## License

MIT
