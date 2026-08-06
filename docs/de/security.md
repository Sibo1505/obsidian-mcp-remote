# Sicherheitshinweise

- **`.env` niemals committen** — steht bereits in `.gitignore`, nur `.env.example` ist im Repo.
- **Secrets regelmäßig rotieren** (`npm run setup -- --force` + Neustart), besonders nach
  Bildschirm-Sharing, einem versehentlich geposteten Token in einem Chat, oder jeder anderen
  ungewollten Sichtbarkeit.
- `OAUTH_PASSWORD` ist der einzige Faktor auf dem öffentlichen `/oauth/authorize`-Endpunkt, falls
  du keinen Passkey registrierst — rate-limited, aber trotzdem nur ein Faktor. Nutze den vom
  Setup-Skript generierten langen Zufallswert, nicht etwas Merkbares. Ein registrierter Passkey
  (siehe [How it works](how-it-works.md#passkey-login)) ist deutlich stärker.
- `TOKEN_INTERNAL` ist doppelt auf dein Tailscale-Netz beschränkt: der Container hat von Anfang an
  nur eine Tailnet-IP (über den `tailscale`-Sidecar, nie `0.0.0.0`), und der Server prüft
  zusätzlich bei jeder Anfrage die Quell-IP gegen Tailscales Adressbereich — ein geleakter Token
  funktioniert nicht von außerhalb.
- Lese-/Schreibzugriff bedeutet: ein geleakter Token erlaubt auch das Auslesen des kompletten
  Vaults, nicht nur Schreibzugriff. Git-Historie schützt vor zerstörerischen Änderungen, nicht vor
  Exfiltration.
- `NTFY_TOPIC` in `.env` setzen für Push-Benachrichtigungen bei Rate-Limit-Treffern und
  fehlgeschlagenen Logins (siehe [How it works](how-it-works.md#push-benachrichtigungen)) — sonst
  merkst du nicht, wenn jemand den Endpunkt testet.
- Dieses Repo hat Dependabot (`.github/dependabot.yml`, npm + Docker-Base-Image) sowie CodeQL und
  gitleaks als GitHub Actions (`.github/workflows/`) aktiv — läuft bei jedem Push/PR, CodeQL
  zusätzlich wöchentlich. Wenn du forkst, aktivier diese Workflows in deinem eigenen Repo mit.
- Dynamic Client Registration (`POST /register`) gibt es **nicht mehr** — der Endpunkt wurde
  entfernt, weil er unauthentifizierte öffentliche Angriffsfläche ohne echten Nutzen war (der
  Custom-Connector-Flow verwendet ausschließlich den vorregistrierten Client aus `.env`). Falls du
  Desktop über `mcp-remote` anbindest: das nutzt ebenfalls den vorregistrierten Client, keine
  eigene Registrierung nötig.
- Registrierte Clients und ausgestellte Tokens liegen als Klartext-JSON (`OAUTH_STORE_PATH`), nicht
  verschlüsselt. Akzeptiertes Risiko für dieses Bedrohungsmodell (dein VPS hält `.env` ohnehin im
  Klartext) — aber relevant, falls du dieses Volume irgendwo hin sicherst oder verschiebst: wie
  jede andere Secrets-Datei behandeln.
- `npm run oauth:list` / `npm run oauth:revoke -- <client_id>` zeigen registrierte Clients/Tokens
  an bzw. widerrufen sie — der einzige Weg, eine erteilte Berechtigung ohne Admin-UI einzusehen
  oder rückgängig zu machen. Braucht einen Container-Neustart, um zu greifen.
- Rate-Limiting ist In-Memory pro Prozess und übersteht keinen Container-Neustart — für ein
  Single-Container-Deployment akzeptabel, aber kein garantierter Schutz über einen Redeploy
  hinweg.
- Der Server läuft mit eigener Tailscale-Identität statt im selben Docker-Netz wie andere Dienste
  auf deinem VPS — Details dazu unter [Netzwerk-Isolation](how-it-works.md#netzwerk-isolation).
  Wenn du eigene zusätzliche Dienste im selben Docker-Netz wie einen Reverse Proxy betreibst,
  achte darauf, dass der neue öffentliche Container nicht mit hineingezogen wird.

---
Weiter mit der [Installation](installation.md).
