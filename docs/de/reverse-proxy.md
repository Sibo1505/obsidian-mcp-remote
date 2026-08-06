# Reverse-Proxy einrichten (für Mobile/Web-Zugriff)

Nur nötig, wenn du den Server auch von Claude Mobile/Web aus nutzen willst (die externe/OAuth-Zone).
Wenn du nur über Tailscale von Claude Desktop/Code aus zugreifst, kannst du das komplett
überspringen.

Diese Anleitung geht konkret [Nginx Proxy Manager](https://nginxproxymanager.com/) (NPM) durch,
weil das Projekt darauf getestet ist. Jeder Reverse Proxy, der TLS terminieren und an eine
beliebige IP:Port weiterleiten kann, funktioniert grundsätzlich (Caddy, Traefik, plain nginx) —
worauf es unabhängig von deiner Wahl ankommt, ist das **Forward-Ziel**, siehe unten.

## Zeitpunkt: jetzt installieren, später konfigurieren

Die Proxy-Software selbst installierst du schon während der [Vorbereitung](prerequisites.md) —
den eigentlichen Proxy Host kannst du aber erst konfigurieren, sobald du dessen Forward-Ziel
kennst: die Tailscale-IP des Sidecars, die erst existiert, nachdem du ihn während der
[Installation](installation.md) gestartet hast. Reihenfolge:

1. NPM jetzt installieren (siehe unten)
2. [Installation](installation.md) bis zum Start des `tailscale`-Sidecars durchführen und dessen
   IP notieren (`docker exec obsidian-mcp-remote-tailscale tailscale ip -4`)
3. Hierher zurückkommen und den Proxy Host konfigurieren
4. Mit dem Rest der Installation weitermachen

## NPM installieren

```yaml
# docker-compose.yml für NPM, auf deinem VPS — komplett getrennt von der Compose-Datei dieses Projekts
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "81:81"   # Admin-UI — überleg, das nur an deine Tailscale-IP zu binden, nicht 0.0.0.0
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

`docker compose up -d`, dann `http://<deine-vps-ip>:81` öffnen — Standard-Login
`admin@example.com` / `changeme`, beides sofort ändern.

## DNS

Den A-Record deiner Domain auf die **öffentliche** IP deines VPS zeigen lassen (nicht die
Tailscale-IP — der ganze Sinn eines Reverse Proxys hier ist, Verbindungen aus dem öffentlichen
Internet anzunehmen, die nur die echte öffentliche IP erreichen). Cloudflare-Nutzer: Record auf
**DNS-only** (graue Wolke) lassen, außer du willst bewusst zusätzlich Cloudflares Proxy/WAF
davorschalten — das ist eine separate Entscheidung mit eigenen Abwägungen, hier nicht behandelt.

## Proxy Host anlegen

In NPM: **Proxy Hosts → Add Proxy Host**

| Feld | Wert |
|---|---|
| Domain Names | deine Domain (z.B. `obsidian-mcp.deine-domain.dev`) |
| Scheme | `http` |
| Forward Hostname / IP | die Tailscale-IP des Sidecars aus Schritt 2 oben (z.B. `100.x.x.x`) |
| Forward Port | `3000` |

**SSL-Tab:** Request a new SSL Certificate → **Force SSL** an → **HTTP/2 Support** an. Die **DNS
Challenge** nutzen, falls dein VPS auf Port 80 noch nicht aus dem öffentlichen Internet erreichbar
ist, sonst die **HTTP Challenge** (braucht offenen Port 80 und bereits aufgelöste Domain).

Speichern, dann testen: `curl -i https://<deine-domain>/health` sollte `{"status":"ok"}` liefern.

## Falls sich die Tailscale-IP des Sidecars mal ändert

Passiert normalerweise nicht — Tailscale vergibt einem einmal authentifizierten Gerät eine stabile
IP, und der Sidecar behält seine Identität über Neustarts hinweg, solange sein `ts-state`
Docker-Volume nicht gelöscht wird. Falls doch mal nötig (z.B. nach komplettem Neuaufbau des
Sidecars mit neuem Auth Key): einfach das Feld **Forward Hostname / IP** desselben Proxy Hosts
anpassen — sonst muss nichts geändert werden.
