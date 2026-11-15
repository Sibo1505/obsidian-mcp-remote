# Eingeschränkte Tokens (Scoped tokens)

Optional. Mit einem eingeschränkten Token kann ein Agent auf einem anderen Rechner in deinem
Tailnet **den Vault lesen und in genau einen Ordner schreiben**. Ein typischer Fall: Ein Agent auf
einem Server soll deine Notizen und Regeln lesen und eigene Notizen in einen Eingangsordner legen,
aber sonst nichts ändern können.

Eingeschränkte Tokens nutzen einen **eigenen Listener auf einem eigenen Port**. Der Haupt-Listener
(`PORT`, OAuth und `TOKEN_INTERNAL`) bleibt genau so, wie er ist.

## So funktioniert es

- **Eigener Port, eigene App.** Ist `SCOPED_PORT` gesetzt, startet der Server einen zweiten
  Listener. Dort gibt es nur `POST /mcp` (dieselben fünf Werkzeuge) und `GET /health`. Es gibt dort
  keine OAuth-Routen, keine Login-Seiten und keine statischen Dateien. `TOKEN_INTERNAL` und
  OAuth-Tokens gelten dort nicht.
- **Kein Proxy-Vertrauen.** Der Haupt-Listener vertraut einem Reverse-Proxy-Schritt und liest die
  Absender-Adresse deshalb aus `X-Forwarded-For`. Wer diesen Port direkt erreicht, kann in dem Kopf
  jede Adresse eintragen. Der eingeschränkte Listener vertraut keinem Proxy: Absender ist die
  Adresse der TCP-Verbindung (ohne `::ffff:`), weitergeleitete Köpfe werden ignoriert. Darum müssen
  Clients den Port **direkt** erreichen, nie über einen Reverse Proxy.
- **Exakte Adressen, Ablaufdatum.** Eine Anfrage kommt nur durch mit einem eingetragenen Token, von
  einer der exakten Adressen dieses Tokens (`allowFrom`) und vor `expiresAt`. Ein falscher Token,
  eine falsche Adresse und ein abgelaufener Token bekommen alle dieselbe Antwort
  `401 {"error":"Unauthorized"}`. Den Grund schreibt nur das Server-Log.
- **Lesen** sieht den ganzen Vault außer den Präfixen in `readDeny`. Gesperrte Dateien und Ordner
  blendet `vault_list` aus, `vault_read` lehnt sie ab, und `search_query` lässt sie weg (auch als
  Backlinks). Symlinks werden vorher aufgelöst. Ein Link führt also weder in einen gesperrten Ordner
  noch aus dem Vault hinaus.
- **Schreiben** (`vault_write`, `vault_patch`) prüft der Server, nicht der Client:
  - nur unter `writeDir` und nur `.md`-Dateien;
  - jeder Ordnername passt auf `^[a-z0-9][a-z0-9-]*$`, der Dateiname auf
    `^[a-z0-9][a-z0-9-]*\.md$`. Also keine Punkt-Dateien oder Punkt-Ordner (`.claude/`), keine
    Großbuchstaben, keine Leerzeichen;
  - kein Name, der mit `claude` oder `agents` beginnt (`CLAUDE.md`, `claude-notes.md`, `agents.md`
    in jeder Schreibweise), keine Windows-Gerätenamen (`con`, `prn`, `aux`, `nul`,
    `com1`–`com9`, `lpt1`–`lpt9`);
  - höchstens 100 Zeichen pro Name, höchstens 4 Ebenen unter `writeDir`;
  - der Pfad muss schon in einfacher Form sein: kein `..`, `.`, `//` oder `\`;
  - kein Symlink auf dem Weg vom Vault bis zur Notiz, und die Notiz selbst darf kein Symlink sein
    und keine weiteren Hardlinks haben. Der aufgelöste Ordner muss in `realpath(vault/writeDir)`
    liegen;
  - höchstens 200 KB (UTF-8) pro Notiz, bei `vault_patch` für das Ergebnis;
  - höchstens `writesPerHour` Schreibvorgänge pro Token (gleitende Stunde).
- **Markierte Notizen.** Nach jedem eingeschränkten Schreiben setzt der Server die
  `frontmatter`-Felder des Tokens und ergänzt seine `tags` in der fertigen Notiz, auch wenn ein
  Schreiben oder Patch sie entfernen wollte.
- **Nachvollziehbar.** Der Commit-Text beginnt mit `<name>: vault_write <pfad>` bzw.
  `<name>: vault_patch <pfad>`. Jeder Werkzeug-Aufruf schreibt eine Log-Zeile, nie mit Inhalt oder
  Token:

  ```text
  scoped token=agent tool=vault_write path="notes-inbox/today.md" result=ok
  scoped token=agent tool=vault_write path="CLAUDE.md" result=denied:outside-write-dir
  scoped auth rejected reason=address-not-allowed token=agent from=192.0.2.10
  ```

- **Im Zweifel zu.** Ist an den Einstellungen etwas ungültig, startet der eingeschränkte Listener
  nicht, und das Log sagt warum. Der Haupt-Listener läuft normal weiter. Es gibt nie einen Rückfall
  auf breitere Rechte.

## Einstellungen

| Variable | Bedeutung |
|---|---|
| `SCOPED_PORT` | Port des eingeschränkten Listeners. Leer oder nicht gesetzt: kein zweiter Listener, nichts ändert sich. Muss sich von `PORT` unterscheiden. |
| `SCOPED_TOKENS_JSON` | JSON-Liste der Token-Einträge (unten). Nicht geheim: Sie enthält nur den *Namen* der Variable mit dem Geheimnis. |
| *eine Variable pro Token* | Das Geheimnis selbst, mindestens 32 Zeichen, benannt in `tokenEnv`. Erzeugen mit `openssl rand -hex 32`. |

Felder pro Token (unbekannte Felder sind ein Fehler, damit ein Tippfehler keine Regel still
wegfallen lässt):

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `name` | ja | `[a-z0-9-]`, steht im Log und im Commit-Text. |
| `tokenEnv` | ja | Name der Umgebungsvariable mit dem Geheimnis. Der Wert muss sich von `TOKEN_INTERNAL`, den OAuth-Geheimnissen und den Geheimnissen anderer Tokens unterscheiden. |
| `allowFrom` | ja | Exakte IP-Adressen (keine Bereiche, keine Hostnamen). |
| `writeDir` | ja | Der eine beschreibbare Ordner, relativ zum Vault, nach den Namensregeln oben. |
| `readDeny` | nein | Pfad-Präfixe (Ordner oder Dateien), die der Token nicht lesen darf. Standard: leer, also ist alles lesbar. |
| `expiresAt` | ja | ISO-Datum (`2026-12-31`, gemeint ist 00:00 UTC) oder Datum mit Uhrzeit und Zeitzone (`2026-12-31T23:59:00Z`). Danach: 401 und eine Log-Zeile. |
| `writesPerHour` | nein | Standard 60. |
| `frontmatter` | nein | Felder, die der Server in jeder Notiz dieses Tokens setzt (Text, Zahl, Ja/Nein; nicht `tags`). |
| `tags` | nein | Tags, die der Server in jeder Notiz dieses Tokens ergänzt. |

Beispiel (`.env`; die einfachen Anführungszeichen halten das JSON zusammen):

```bash
SCOPED_PORT=3001
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"notes-inbox","readDeny":["private/"],"expiresAt":"2026-12-31","writesPerHour":60,"frontmatter":{"source":"agent"},"tags":["agent"]}]'
TOKEN_AGENT=<openssl rand -hex 32>
```

Alle drei kommen in den Container (`docker-compose.yml` gibt `SCOPED_PORT` und
`SCOPED_TOKENS_JSON` schon weiter; deine Geheimnis-Variable ergänzt du daneben). Mit dem
Tailscale-Sidecar ist der Container über seine Tailnet-Adresse erreichbar. Lege für den
eingeschränkten Port also **kein** `ports:`-Mapping an.

Auf dem Agent-Rechner schickst du das Geheimnis als `Authorization: Bearer <geheimnis>` an
`http://<Tailnet-Adresse des Servers>:3001/mcp`.

## Netz-Regeln

Die Token-Prüfung ist eine Schicht, das Netz sollte die zweite sein:

- Erlaube dem Agent-Rechner in deiner Tailnet-Policy **nur** den eingeschränkten Port dieses
  Servers, zum Beispiel (die Tags sind Platzhalter):

  ```json
  { "action": "accept", "src": ["tag:agent"], "dst": ["tag:vault-server:3001"] }
  ```

- Gib diesem Rechner nie den Haupt-Port (`PORT`). Dessen Login-Seite und `TOKEN_INTERNAL` sind
  nicht für ihn gedacht, und dieser Port vertraut `X-Forwarded-For`.
- Leg den eingeschränkten Port nie hinter einen Reverse Proxy. Sonst kommt jede Anfrage von der
  Adresse des Proxys, und `allowFrom` kann die Rechner nicht mehr unterscheiden.

## Grenzen

- **Lesen ist breit.** Standardmäßig liest der Token alles, was nicht in `readDeny` steht. Es ist
  eine Sperrliste, neue Ordner sind also erst einmal lesbar. Ein Agent, der fremden Text liest
  (Webseiten, Issues, Mails), kann dazu gebracht werden, Gelesenes nach außen zu schicken. Git
  schützt vor ungewollten Änderungen, nicht vor Abfluss. Private Inhalte gehören in `readDeny` oder
  gar nicht in diesen Vault.
- **Notizen sind Daten.** Die Namensregeln verhindern Anweisungs- oder Konfigurationsdateien. Der
  *Text* einer Notiz kann aber trotzdem Anweisungen für den enthalten, der sie später liest.
  Behandle Notizen eines eingeschränkten Tokens (erkennbar an seinem `frontmatter` und seinen
  `tags`) als Daten, nicht als Anweisungen, und prüfe sie, bevor du sie woandershin verschiebst.
- **Das Geheimnis liegt auf dem Agent-Rechner.** Es gilt nur auf dem eingeschränkten Port, nur von
  den eingetragenen Adressen und nur bis `expiresAt`. Zum Wechseln änderst du die Variable und
  startest neu.
- **Symlinks.** Alle Prüfungen lösen sie auf, und unter Linux lehnt schon das Öffnen der Datei einen
  Symlink ab (`O_NOFOLLOW`). Nicht abgedeckt ist ein anderer Prozess, der den Ordner genau zwischen
  Prüfung und Schreiben ändert.
- **Zähler liegen im Speicher.** `writesPerHour` und das Anfrage-Limit beginnen nach einem Neustart
  wieder bei null.

---
Zurück zu den [Sicherheitshinweisen](security.md).
