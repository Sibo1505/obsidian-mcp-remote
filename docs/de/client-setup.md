# Client-Verbindung

Setzt eine erfolgreiche [Kontrolle](verification.md) voraus. Drei Clients, je nach dem was du
nutzt — alle drei können parallel eingerichtet sein.

## Claude Code / alles was einen statischen Bearer-Token akzeptiert
Interne Zone, über Tailscale — kein OAuth nötig:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://<tailscale-sidecar-ip>:3000/mcp",
      "headers": { "Authorization": "Bearer <TOKEN_INTERNAL aus .env>" }
    }
  }
}
```

## Claude Desktop
Läuft über `mcp-remote`, da Desktop kein Streamable HTTP direkt spricht:

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

`--header`-Auth funktioniert hier nicht — `mcp-remote` führt immer seinen OAuth-Discovery-Flow
aus, unabhängig von Flags. Desktop läuft also über die externe/OAuth-Zone, nicht über
`TOKEN_INTERNAL`. Bei der ersten Verbindung öffnet sich ein Browser mit `/oauth/authorize` — dort
mit Passkey (falls registriert) oder Passwort einloggen. Der ausgestellte Refresh-Token hält dich
über Neustarts hinweg eingeloggt.

## claude.ai Custom Connector (Mobile/Web)
Externe Zone, braucht `DOMAIN`:

Settings → Connectors → Add custom connector → `https://<DOMAIN>/mcp`, unter "Erweiterte
Einstellungen" `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` aus `.env` eintragen. Gleicher
`/oauth/authorize`-Login wie bei Desktop oben.

## Passkey registrieren (empfohlen für alle externen Verbindungen)

1. `https://<DOMAIN>/webauthn/setup` öffnen
2. `OAUTH_PASSWORD` eingeben, dann dem Browser-Prompt für den Passkey folgen (Windows Hello,
   Fingerabdrucksensor, Hardware-Key)
3. Ab jetzt zeigt `/oauth/authorize` einen Passkey-Login-Button, Passwort bleibt als Fallback

Nur ein Passkey gleichzeitig gespeichert (Single-User-Tool) — ein neuer ersetzt den alten. Braucht
die echte öffentliche HTTPS-`DOMAIN`, funktioniert nicht gegen eine rohe Tailscale-IP oder HTTP.

---
Fertig eingerichtet — siehe [How it works](how-it-works.md) für Details zur Funktionsweise, oder
[Sicherheitshinweise](security.md) für den laufenden Betrieb.
