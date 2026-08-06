# Voraussetzungen & Vorbereitung

Zwei Phasen, bevor die eigentliche Installation losgeht. Beides machst du selbst — es hängt zu
stark von deinem konkreten VPS/Provider ab, um das sinnvoll zu automatisieren.

## Phase 1 — Was du brauchst

- **Ein VPS** mit Docker-Unterstützung. Debian/Ubuntu empfohlen (worauf dieses Projekt getestet
  ist), andere Linux-Distributionen funktionieren ebenso, solange Docker läuft.
- **Ein Git-Remote für deinen Vault** — Gitea, GitHub, GitLab, egal welcher Anbieter. Der Server
  braucht irgendeinen Ort, von dem er per `git pull`/`git push` synchronisieren kann. Wenn du
  noch keinen hast: ein privates Repo bei [Gitea](https://gitea.com) (selbst gehostet) oder
  [GitHub](https://github.com) (privates Repo, kostenlos) reicht.
- **Ein Claude-Account** mit Zugriff auf [Custom Connectors](https://claude.ai) (Settings →
  Connectors), falls du den Server auch von Claude Mobile/Web aus nutzen willst. Für Claude
  Desktop/Code reicht ein normaler Account.
- **Optional: eine eigene Domain**, falls du von unterwegs (Mobile/Web, ohne VPN) zugreifen willst.
  Ohne Domain funktioniert der Server trotzdem — dann nur innerhalb deines Tailscale-Netzes
  (Desktop/Code).

## Phase 2 — Was du vorher installierst

Reihenfolge spielt keine Rolle, aber alle vier sollten stehen bevor du zur
[Installation](installation.md) übergehst. Wenn auf deinem VPS schon Docker/Tailscale/etc. laufen
(z.B. weil du dort schon andere Projekte hostest), überspring einfach was schon da ist.

| Was | Wofür | Anleitung |
|---|---|---|
| **Docker + Docker Compose** | Der Server selbst läuft als Container | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) |
| **Tailscale** (empfohlen) | Sicherer interner Zugriff (Desktop/Code) ohne öffentliche Exposition, und der Server bekommt später seine eigene Identität im Tailnet | [tailscale.com/download](https://tailscale.com/download) — Account erstellen, auf dem VPS `tailscale up` |
| **Ein Reverse Proxy mit TLS** (nur nötig für Mobile/Web) | Terminiert HTTPS, leitet auf den Server weiter | Siehe [Reverse-Proxy einrichten](reverse-proxy.md) — Software jetzt installieren, den eigentlichen Proxy Host erst während der Installation konfigurieren |
| **Git** auf dem VPS-Host | Nicht zwingend nötig (der Server macht Git-Operationen im Container), aber praktisch zum Debuggen | Meist schon vorinstalliert (`git --version` prüfen) |
| **Node.js 20+** auf dem VPS-Host (nur für `npm run wizard`/`verify`/`setup`) | Der Server selbst läuft komplett containerisiert und braucht nie Node auf dem Host — aber das Setup-Tooling aus [Installation](installation.md) Weg A/C schon, da es reine `.mjs`-Skripte sind, die direkt laufen, nicht im Docker-Container. Überspringbar, wenn du nur Weg B (den `/onboard`-Claude-Code-Skill) nutzt oder die `.env` von Hand schreibst. | [nodejs.org](https://nodejs.org/en/download) oder der Paketmanager deiner Distribution |

**Wenn du einen komplett cleanen VPS hast:** Fang mit Docker an (`curl -fsSL
https://get.docker.com | sh`), dann Tailscale, dann optional den Reverse Proxy. Kein Gitea nötig,
falls du stattdessen ein privates GitHub-Repo für den Vault nutzt.

**Wenn du schon einen laufenden VPS mit anderen Diensten hast:** Achte beim Reverse Proxy darauf,
dass der neue Server nicht versehentlich andere Dienste mit-exponiert — siehe die Hinweise zum
Netzwerk-Setup in [How it works](how-it-works.md#netzwerk-isolation).

Fertig? Weiter mit der [Installation](installation.md).
