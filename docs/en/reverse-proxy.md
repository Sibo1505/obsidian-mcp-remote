# Reverse proxy setup (for Mobile/Web access)

Only needed if you want to use the server from Claude Mobile/Web (the external/OAuth zone). If
you're only connecting from Claude Desktop/Code over Tailscale, skip this entirely.

This walks through [Nginx Proxy Manager](https://nginxproxymanager.com/) (NPM) specifically,
since that's what this project is tested against. Any reverse proxy that can terminate TLS and
forward to an arbitrary IP:port works in principle (Caddy, Traefik, plain nginx) — the one thing
that matters regardless of which you pick is the **forward target**, explained below.

## Timing: install now, configure after

Install the proxy software itself during [Preparation](prerequisites.md) — but you can't
configure the actual proxy host yet at that point, because its forward target is the Tailscale
sidecar's own IP, which only exists once you've started it during
[Installation](installation.md). Order:

1. Install NPM now (below)
2. Do [Installation](installation.md) up through starting the `tailscale` service and noting its
   IP (`docker exec obsidian-mcp-remote-tailscale tailscale ip -4`)
3. Come back here to configure the proxy host
4. Continue with the rest of Installation

## Installing NPM

```yaml
# docker-compose.yml for NPM, on your VPS — separate from this project's own compose file
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "81:81"   # admin UI — consider binding this to your Tailscale IP only, not 0.0.0.0
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

`docker compose up -d`, then open `http://<your-vps-ip>:81` — default login `admin@example.com` /
`changeme`, change both immediately.

## DNS

Point your domain's A record at your VPS's **public** IP address (not its Tailscale IP — the
whole reason for a reverse proxy here is to accept connections from the public internet, which
only reaches your VPS's real public IP). Cloudflare users: keep the record **DNS-only** (grey
cloud) unless you specifically want Cloudflare's proxy/WAF in front too — that's a separate choice
with its own trade-offs, not covered here.

## Creating the proxy host

In NPM: **Proxy Hosts → Add Proxy Host**

| Field | Value |
|---|---|
| Domain Names | your domain (e.g. `obsidian-mcp.yourdomain.dev`) |
| Scheme | `http` |
| Forward Hostname / IP | the Tailscale sidecar's IP from step 2 above (e.g. `100.x.x.x`) |
| Forward Port | `3000` |

**SSL tab:** Request a new SSL Certificate → **Force SSL** on → **HTTP/2 Support** on. Use the
**DNS Challenge** if your VPS itself isn't reachable on port 80 from the public internet yet, the
**HTTP Challenge** otherwise (needs port 80 open and the domain already resolving).

Save, then test: `curl -i https://<your-domain>/health` should return `{"status":"ok"}`.

## If the sidecar's Tailscale IP ever changes

It normally doesn't — Tailscale assigns a stable IP to a device once authenticated, and the
sidecar keeps its identity across restarts as long as its `ts-state` Docker volume isn't deleted.
If you ever do need to update it (e.g. after recreating the sidecar from scratch with a new auth
key), edit the same proxy host's **Forward Hostname / IP** field — nothing else needs to change.
