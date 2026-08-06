# Wie der Server funktioniert

## Die fünf Tools

Identisch zum lokalen Obsidian-MCP-Setup, drop-in-kompatibel:

| Tool | Macht |
|---|---|
| `vault_read` | Notiz lesen, optional nur eine Überschrift/einen Block daraus |
| `vault_write` | Notiz komplett schreiben (neu oder überschreiben) |
| `vault_patch` | Gezielt einen Abschnitt/eine Überschrift einer bestehenden Notiz ändern |
| `vault_list` | Ordnerinhalt auflisten |
| `search_query` | Vault durchsuchen — JsonLogic-Abfragen über Frontmatter, Inhalt, Wikilinks |

## Zwei-Zonen-Auth-Modell

Der Server unterscheidet, woher eine Anfrage kommt, und verlangt entsprechend unterschiedlich
starke Beweise:

- **Intern** (dein Tailscale-Netz — Claude Desktop direkt, Claude Code): ein statischer
  Bearer-Token (`TOKEN_INTERNAL`). Reicht, weil Tailscale selbst schon eine verschlüsselte,
  authentifizierte Verbindung ist — der Token schützt nur zusätzlich davor, dass irgendwer in
  deinem Tailnet den Server nutzen kann, nicht nur du.
- **Extern** (öffentliches Internet — Mobile/Web Custom Connector): ein echter OAuth-2.0-Server
  mit PKCE (S256 zwingend), Login per Passkey oder Passwort. Nötig, weil claude.ai von seiner
  eigenen Cloud aus verbindet, nicht aus deinem Tailnet — Tailscale allein reicht hier nicht.

Ein wichtiges Detail: Ein geleakter `TOKEN_INTERNAL` funktioniert **nicht** von außerhalb deines
Tailnets — der Server prüft bei jeder Anfrage zusätzlich, ob sie tatsächlich aus dem
Tailscale-Adressbereich kommt (`combinedAuth`). Die beiden Zonen sind also nicht nur durch
unterschiedliche Tokens getrennt, sondern durch eine echte Netzwerk-Prüfung.

## Git als Sicherheitsnetz

Jede Änderung ist ein normaler Datei-Schreibzugriff im Vault-Checkout, gefolgt von einem
automatischen `git commit` + `push`. Nichts geht "verloren" — jede Änderung ist über die normale
Git-Historie (`git revert`, oder direkt im Gitea/GitHub-UI) rückgängig machbar, genau wie bei
jedem anderen Repo.

Vor jedem Lesezugriff macht der Server außerdem einen `git pull`, damit du auch dann die aktuelle
Version siehst, wenn die Notiz gerade von einem anderen Gerät geändert wurde. Bei einem echten
Konflikt (zwei Geräte ändern dieselbe Notiz gleichzeitig) landet die neuere Version in einer
`<name>.claude-conflict.<timestamp>.md`-Datei statt den Sync zu blockieren — du entscheidest dann
selbst, was davon bleibt.

## Netzwerk-Isolation

Der Server läuft mit einer **eigenen Tailscale-Identität** (ein `tailscale`-Sidecar-Container im
`docker-compose.yml`) statt im selben Docker-Netz wie ein eventuell vorhandener Reverse Proxy oder
andere Dienste auf deinem VPS. Grund: Wenn du den Server öffentlich erreichbar machst (für
Mobile/Web), ist er der einzige Baustein auf deinem VPS, der tatsächlich vom Internet aus
ansprechbar ist — eine eigene Netzwerk-Identität sorgt dafür, dass eine Kompromittierung genau
dieses einen Containers keinen direkten Zugriff auf andere Dienste in deinem Docker-Netz eröffnet
(Gitea, Datenbanken, Admin-Oberflächen, was auch immer sonst noch bei dir läuft).

Praktisch bedeutet das: Dein Reverse Proxy leitet nicht an einen Docker-Container-Namen weiter,
sondern an die eigene Tailscale-IP des Sidecars — wie an jedes andere Gerät in deinem Tailnet auch.

## Passkey-Login

`/oauth/authorize` akzeptiert einen WebAuthn-Passkey (Windows Hello, Fingerabdrucksensor,
Hardware-Sicherheitsschlüssel) statt eines Passworts — nicht phishbar wie ein Passwort, meist
schneller. Einmalig einrichten unter `https://<DOMAIN>/webauthn/setup` (mit dem `OAUTH_PASSWORD`
freigeschaltet), danach zeigt der Login-Screen einen Passkey-Button, das Passwort bleibt als
Fallback bestehen.

## Push-Benachrichtigungen

Optional (`NTFY_TOPIC` in `.env`): eine Push-Nachricht via [ntfy.sh](https://ntfy.sh) bei jedem
falschen Login-Versuch oder ausgelösten Rate-Limit — damit dir ein Angriffsversuch nicht entgeht,
ohne dass du extra Logs durchsuchen musst.

---
Weiter mit [Sicherheitshinweisen](security.md) oder direkt zur [Installation](installation.md).
