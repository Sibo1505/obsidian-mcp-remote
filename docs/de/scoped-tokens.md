# Eingeschränkte Tokens (Scoped tokens)

Optional. Mit einem eingeschränkten Token kann ein Agent auf einem anderen Rechner in deinem
Tailnet **den Vault lesen und entweder in genau einen Ordner schreiben oder überall außer in den
Pfaden, die du sperrst**. Typische Fälle: Ein Agent auf einem Server liest deine Notizen und Regeln
und legt eigene Notizen in einen Eingangsordner, kann aber sonst nichts ändern
(`writeDir: "notes-inbox"`). Oder er darf Notizen dort ablegen, wo sie hingehören, aber nie die
Agent-Konfiguration oder deine Regel-Notizen anfassen (`writeDir: "/"` mit `writeDeny`).

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
  Adresse der TCP-Verbindung, weitergeleitete Köpfe werden ignoriert. Darum müssen Clients den Port
  **direkt** erreichen, nie über einen Reverse Proxy.
- **Exakte Adressen, Ablaufdatum.** Eine Anfrage kommt nur durch mit einem eingetragenen Token, von
  einer der exakten Adressen dieses Tokens (`allowFrom`) und vor `expiresAt`. Ein falscher Token,
  eine falsche Adresse und ein abgelaufener Token bekommen alle dieselbe Antwort
  `401 {"error":"Unauthorized"}`. Den Grund schreibt nur das Server-Log.
- **Eine Nachricht pro Anfrage, mit Limit.** Der eingeschränkte Port nimmt pro HTTP-Anfrage genau
  eine JSON-RPC-Nachricht an; ein Batch bekommt `400`. Mehr als 60 Anfragen pro Minute von einer
  Adresse bekommen `429` (gezählt vor der Token-Prüfung, getrennt vom Haupt-Port).
- **Lesen** sieht den ganzen Vault außer den Präfixen in `readDeny`. Gesperrte Dateien und Ordner
  blendet `vault_list` aus, `vault_read` lehnt sie ab, und `search_query` lässt sie weg (auch als
  Backlinks). Ein Eintrag gilt auch für seinen Namensvetter: `projects/plan.md` sperrt den Ordner
  `projects/plan/`, und `resources/ops` sperrt die Notiz `resources/ops.md` (eine Hub-Notiz und ihr
  Ordner gehören zusammen). Symlinks werden vorher aufgelöst. Ein Link führt also weder in einen gesperrten Ordner
  noch aus dem Vault hinaus. Lesezugriffe teilen sich höchstens alle 10 Sekunden ein `git pull`. Sie
  können dem Remote also bis zu 10 Sekunden hinterherhinken.
- **Die Suche hat ein Budget.** Für einen eingeschränkten Token lehnt `search_query` Abfragen ab, die
  größer als 8 KB sind, tiefer als 20 Ebenen gehen oder mehr als 500 Werte haben. Ein
  `glob`-Muster hat höchstens 200 Zeichen, und geschweifte Klammern gelten wörtlich (`{a,b}` wird
  nicht aufgefächert). Mehr als 500 Treffer, ein Ergebnis über 1 MB oder mehr als 5 Sekunden für
  das Lesen und Auswerten der Notizen (geprüft zwischen den Notizen) enden mit einem Fehler, der um
  eine engere Abfrage bittet, nie mit einer still gekürzten Liste.
- **Die Suche läuft in einem eigenen Thread.** Eine eingeschränkte Suche läuft in einem
  Worker-Thread mit Speichergrenze (256 MB) und wird nach 10 Sekunden gestoppt, egal, was sie gerade
  tut, auch mitten in einem einzelnen langsamen regulären Ausdruck. Es läuft immer nur eine
  eingeschränkte Suche; eine zweite bekommt einen Fehler („Another search is still running“),
  statt zu warten. Der Server selbst, und damit der Haupt-Port, antwortet weiter. Diesen einen
  Platz teilen sich alle eingeschränkten Tokens: Ein Client, der alle 10 Sekunden eine teure Suche
  schickt, hält ihn (und einen CPU-Kern) dauerhaft belegt, und andere eingeschränkte Tokens bekommen
  solange diesen Fehler.
- **Ergebnisse haben eine Obergrenze.** Jedes eingeschränkte Ergebnis darf als JSON höchstens etwa
  2 MB und 100 000 Werte haben. Der Server misst das, bevor er die Antwort baut, und zählt dabei
  jeden YAML-Alias (`*name`) bei jeder Verwendung. Eine kleine Notiz, deren Frontmatter sich zu
  Millionen Werten ausrollt, wird also abgelehnt statt ausgerollt. `vault_read` lehnt eine Datei
  über 2 MB ab, bevor es sie liest.
- **Schreiben** (`vault_write`, `vault_patch`) prüft der Server, nicht der Client:
  - nur unter `writeDir`, mit `writeDir: "/"` überall im Vault. Nie in einen Pfad aus `writeDeny`
    oder `readDeny` (ohne Groß-/Kleinschreibung verglichen, Namensvettern wie beim Lesen
    eingeschlossen);
  - jeder Teil des Pfads, ob es ihn schon gibt oder nicht: keine Punkt-Dateien oder Punkt-Ordner
    (`.claude/`, `.obsidian/`), keine Zeichen, die ein Betriebssystem nicht speichern kann
    (`<>:"|?*`, Steuerzeichen, Leerzeichen oder Punkt am Ende), nur `.md`-Notizen, kein Name, der
    mit einem der bekannten Anweisungsnamen von Agents beginnt (Liste unter [Grenzen](#grenzen)),
    und keine Windows-Gerätenamen (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`).
    Ordner wie `claude-skills/` bleiben damit auch ohne `writeDeny`-Eintrag gesperrt;
  - **was das Schreiben neu anlegt** (neue Ordner und eine neue Notiz), muss auf
    `^[a-z0-9][a-z0-9-]*$` (Ordner) bzw. `^[a-z0-9][a-z0-9-]*\.md$` (Notizen) passen: keine
    Großbuchstaben, keine Leerzeichen. Vorhandene Ordner und Notizen behalten ihre Namen. Mit
    `writeDir: "/"` kann ein Token also `Projects/x.md` schreiben oder `My Notes/Idea.md` ändern,
    aber nicht `Projects/My Idea.md` anlegen;
  - ein neuer Name darf sich von einem vorhandenen Nachbarn nicht nur in Groß-/Kleinschreibung
    unterscheiden (`notes.md` neben `Notes.md`): Auf den Dateisystemen, auf die der Vault
    synchronisiert wird, wären beide dieselbe Datei;
  - höchstens 100 Zeichen pro Name. Mit einem Schreibordner höchstens 4 Pfadteile unter `writeDir`,
    Ordner und Datei zusammen gezählt (`notes-inbox/a/b/c/x.md` ist das Tiefste, was geht); mit
    `writeDir: "/"` höchstens 10 Pfadteile und höchstens 3 neue Ordner pro Schreibvorgang;
  - höchstens 170 Zeichen für den ganzen Pfad relativ zum Vault, vorhandene Ordner mitgezählt.
    Windows erlaubt 260 Zeichen pro Pfad, den Vault-Ordner eingeschlossen, und Git für Windows
    bricht einen Pull bei längeren Pfaden ab. Eine Konfliktkopie (unten) darf bis zu 200 haben;
  - der Pfad muss schon in einfacher Form sein: kein `..`- oder `.`-Teil, kein `//`, kein `\`, kein
    `/` am Anfang;
  - all das wird geprüft, bevor etwas angelegt wird: Ein abgelehntes Schreiben hinterlässt keine
    leeren Ordner;
  - kein Symlink auf dem Weg vom Vault bis zur Notiz, und die Notiz selbst darf kein Symlink sein
    und keine weiteren Hardlinks haben. Der aufgelöste Ordner muss in `realpath(vault/writeDir)`
    liegen;
  - höchstens 200 KB (UTF-8) pro Notiz, bei `vault_patch` für das Ergebnis;
  - kein Frontmatter, das eine Liste oder ein Mapping über einen YAML-Alias (`*name`) wiederverwendet,
    und keines mit mehr als 10 000 Werten oder etwa 2 MB, wenn es ausgeschrieben wird (ein langer
    Text, der über einen Alias wiederverwendet wird, zählt jedes Mal voll, ebenso jede Liste und
    jedes Mapping): Ein paar hundert Byte Aliase können für jeden späteren Leser Milliarden Werte
    bedeuten, und das Schreiben von YAML dauert mit dem Quadrat der Zahl der Listen und Mappings.
    `vault_patch` prüft das Frontmatter der vorhandenen Notiz und bei einem Frontmatter-Patch den
    neuen Wert genauso, bevor es die Notiz ändert;
  - höchstens `writesPerHour` Schreibversuche pro Token (gleitende Stunde). Ein `vault_write` zählt,
    sobald der Pfad die Prüfungen am Text besteht (Schreibordner, Sperrlisten, die Namen aller
    Teile, Länge) und die Notiz die Größengrenze; ein `vault_patch` zählt, sobald die Notiz gefunden
    und gelesen ist. Jede Ablehnung danach zählt mit: ein neuer Name, der nicht einfach ist, ein
    Groß/klein-Zwilling, ein Symlink auf dem Weg, das Frontmatter, eine fehlende Überschrift, die
    Größe der geänderten Notiz.
- **Markierte Notizen.** Nach jedem eingeschränkten Schreiben setzt der Server die
  `frontmatter`-Felder des Tokens und ergänzt seine `tags` in der fertigen Notiz, auch wenn ein
  Schreiben oder Patch sie entfernen wollte.
- **Konflikte.** Hat jemand dieselbe Notiz gleichzeitig geändert, behält der Server die Fassung des
  Tokens als `<name>-conflict-<jjjjmmtthhmmss>.md` daneben, nach denselben Regeln. Der Name wird
  vorher auf einen einfachen Namen gebracht (`My Idea.md` → `my-idea-conflict-….md`).
- **Nachvollziehbar.** Der Commit-Text beginnt mit `<name>: vault_write <pfad>`,
  `<name>: vault_patch <pfad>` oder `<name>: conflict quarantined <pfad>`. Jede Anfrage schreibt
  eine Log-Zeile, nie mit Inhalt oder Token. Ein Werkzeug-Aufruf, der abgelehnt wird, bevor das
  Werkzeug läuft (ungültige Argumente, oder ein Client, der das Antwortformat nicht annimmt),
  bekommt eine Zeile mit `result=rejected`. Pfade über 300 Zeichen kürzt das Log:

  ```text
  scoped token=agent method=tools/list
  scoped token=agent tool=vault_write path="notes-inbox/today.md" result=ok
  scoped token=agent tool=vault_write path="CLAUDE.md" result=denied:outside-write-dir
  scoped token=agent tool=vault_patch path="rules/house-rules.md" result=denied:write-denied
  scoped token=agent tool=vault_read path="missing.md" result=error:ENOENT
  scoped token=agent method=tools/call tool=vault_write result=rejected
  scoped auth rejected reason=address-not-allowed token=agent from=192.0.2.10
  ```

  Fehlerantworten an den Client enthalten nie Serverpfade: Systemfehler werden zu festen Texten wie
  `Not found: <pfad>`, der Fehlercode steht nur im Log.
- **Im Zweifel zu.** Ist an den Einstellungen etwas ungültig, startet der eingeschränkte Listener
  nicht, und das Log nennt das Feld. Der Haupt-Listener läuft normal weiter. Es gibt nie einen
  Rückfall auf breitere Rechte.

## Einstellungen

| Variable | Bedeutung |
|---|---|
| `SCOPED_PORT` | Port des eingeschränkten Listeners. Leer oder nicht gesetzt: kein zweiter Listener, nichts ändert sich. Muss sich von `PORT` unterscheiden. |
| `SCOPED_HOST` | Optional: IP-Adresse, an die der eingeschränkte Listener gebunden wird. Leer oder nicht gesetzt: **alle Interfaces** (wer ihn erreicht, entscheiden dann die Netz-Regeln unten). |
| `SCOPED_TOKENS_JSON` | JSON-Liste der Token-Einträge (unten). Nicht geheim: Sie enthält nur den *Namen* der Variable mit dem Geheimnis. |
| *eine Variable pro Token* | Das Geheimnis selbst, mindestens 32 Zeichen, benannt in `tokenEnv`. Erzeugen mit `openssl rand -hex 32`. |

Felder pro Token (unbekannte Felder sind ein Fehler, damit ein Tippfehler keine Regel still
wegfallen lässt):

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `name` | ja | `[a-z0-9-]`, eindeutig; steht im Log und im Commit-Text. |
| `tokenEnv` | ja | Name der Umgebungsvariable mit dem Geheimnis. Ihr **Wert** muss sich von den Werten von `TOKEN_INTERNAL`, `OAUTH_CLIENT_SECRET`, `OAUTH_PASSWORD` und den Geheimnissen aller anderen Tokens unterscheiden. |
| `allowFrom` | ja | Exakte IP-Adressen (keine Bereiche, keine Hostnamen). Gespeichert in einheitlicher Schreibweise, `FD7A:115C:A1E0:0:0:0:0:1` und `fd7a:115c:a1e0::1` sind also dieselbe Adresse. |
| `writeDir` | ja | Der eine beschreibbare Ordner, relativ zum Vault, nach den Namensregeln oben; oder genau `"/"` für den ganzen Vault. Ein leerer Wert ist ein Fehler, nie „alles“. |
| `writeDeny` | nein | Pfad-Präfixe (Ordner oder Dateien), die der Token nicht schreiben darf, wie bei `readDeny`. Standard: leer. Vor allem für `writeDir: "/"`: Trag ein, was die Geräte des Vaults als Regeln oder Konfiguration behandeln. Die Werkzeug-Beschreibungen nennen diese Einträge nie; ein gesperrtes Schreiben sagt es erst, wenn es passiert. |
| `readDeny` | nein | Pfad-Präfixe (Ordner oder Dateien), die der Token nicht lesen darf: Ein Eintrag gilt für sich selbst, alles darunter und seinen Namensvetter (`x.md` und `x/`), ohne Groß-/Kleinschreibung. Standard: leer, also ist alles lesbar. Jeder Eintrag ist auch für das Schreiben gesperrt. Mit einem Schreibordner ist ein Eintrag, der sich mit `writeDir` überschneidet (ihn abdeckt, in ihm liegt oder darüber liegt), ein Fehler. |
| `expiresAt` | ja | ISO-Datum (`2026-12-31`, gemeint ist 00:00 UTC) oder Datum mit Uhrzeit und Zeitzone (`2026-12-31T23:59:00Z`). Danach: 401 und eine Log-Zeile. |
| `writesPerHour` | nein | Standard 60. Zählt Schreibversuche ab dem oben beschriebenen Punkt, auch abgelehnte. |
| `frontmatter` | nein | Felder, die der Server in jeder Notiz dieses Tokens setzt (Text, Zahl, Ja/Nein; nicht `tags`). |
| `tags` | nein | Tags, die der Server in jeder Notiz dieses Tokens ergänzt. |

Beispiel (`.env`; die einfachen Anführungszeichen halten das JSON zusammen):

```bash
SCOPED_PORT=3001
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"notes-inbox","readDeny":["private/"],"expiresAt":"2026-12-31","writesPerHour":60,"frontmatter":{"source":"agent"},"tags":["agent"]}]'
TOKEN_AGENT=<openssl rand -hex 32>
```

Derselbe Token für den ganzen Vault, aber ohne einen Regel-Ordner und eine einzelne Notiz:

```bash
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"/","writeDeny":["rules/","projects/house-rules.md"],"readDeny":["private/"],"expiresAt":"2026-12-31","frontmatter":{"source":"agent"},"tags":["agent"]}]'
```

Diese Werte kommen in den Container (`docker-compose.yml` gibt `SCOPED_PORT`, `SCOPED_HOST` und
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
- **Gesperrte Namen sind eine Liste bekannter Namen.** Eingeschränktes Schreiben lehnt Datei- und
  Ordnernamen ab, die mit `claude`, `agent` (auch `agents`), `gemini`, `qwen`, `crush`, `warp`,
  `copilot`, `cursor`, `windsurf`, `cline`, `conventions` oder `readme` beginnen, in jeder
  Schreibweise. Das sind die Anweisungs- und Regeldateien verbreiteter Coding-Agents (`CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, `copilot-instructions.md`, ...). Punkt-Dateien und Punkt-Ordner
  (`.cursorrules`, `.claude/`) sind ohnehin gesperrt. Ein Werkzeug, das Anweisungen aus einem
  anderen Namen lädt, ist nicht abgedeckt.
- **Notizen sind Daten.** Die Namensregeln verhindern die Dateien oben. Der *Text* einer Notiz kann
  aber trotzdem Anweisungen für den enthalten, der sie später liest. Behandle Notizen eines
  eingeschränkten Tokens (erkennbar an seinem `frontmatter` und seinen `tags`) als Daten, nicht als
  Anweisungen, und prüfe sie, bevor du sie woandershin verschiebst. Auf Geräten, die den Vault
  synchronisieren, sollten Plugins, die Code aus Notizen ausführen, für diese Notizen aus bleiben
  (zum Beispiel JavaScript-Abfragen in Dataview oder bei Templater „Trigger on new file creation“).
- **Frontmatter wird nie ausgeführt.** Eine Notiz mit JavaScript-Frontmatter (`---js`) wird ohne
  diesen Block gelesen (er wird weder ausgeführt noch zurückgegeben). Eingeschränktes Schreiben und
  `vault_patch` lehnen es ab, sie neu zu schreiben. Frontmatter, das kein gültiges YAML ist, wird als
  normaler Text gelesen (eine Log-Zeile nennt die Notiz). Ein Block, der kein Mapping ist (ein Satz,
  eine Zahl, eine Liste zwischen zwei `---`-Zeilen), ist ebenfalls kein Frontmatter: Die Notiz wird
  als normaler Text gelesen und geschrieben.
- **Den ganzen Vault schreiben heißt Sperrliste.** Mit `writeDir: "/"` ist ein neuer Ordner
  beschreibbar, bis du ihn einträgst. Die Namensregeln halten Agent-Konfiguration fern
  (Punkt-Ordner, `claude*`, `agents*`, ...), aber nicht Notizen, die Menschen oder Agents auf
  anderen Geräten als Regeln *behandeln* (eine Notiz „Hausregeln“, das Entscheidungs-Log eines
  Projekts). Die gehören in `writeDeny`. Vorhandene Notizen, die der Token bearbeitet, bekommen sein
  `frontmatter` und seine `tags`. So siehst du hinterher, was er angefasst hat.
- **Nur einfache neue Namen.** Ordner und Notizen, die ein eingeschränkter Token anlegt, bestehen nur
  aus Kleinbuchstaben (ASCII), Ziffern und `-`: keine Leerzeichen, keine Großbuchstaben, keine
  Umlaute. Vorhandene Namen bleiben, wie sie sind.
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
