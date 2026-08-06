# Kontrolle

```bash
npm run verify
```

Führt die fünf Checks unten automatisch aus und fasst am Ende zusammen, wie viele bestanden haben
— nicht bestandene zeigen direkt eine kurze Fehlerursache. Alternativ manuell, Schritt für
Schritt:

## 1. Container laufen

```bash
docker compose ps
```
Erwartet: `obsidian-mcp-remote` und `obsidian-mcp-remote-tailscale` beide `running`/`healthy`.

## 2. Health-Endpoint

```bash
docker exec obsidian-mcp-remote-tailscale tailscale ip -4
curl http://<tailscale-sidecar-ip>:3000/health
```
Erwartet: `{"status":"ok"}`.

## 3. OAuth-Discovery (nur relevant falls `DOMAIN` gesetzt ist)

```bash
curl https://<DOMAIN>/.well-known/oauth-authorization-server
```
Erwartet: ein JSON-Dokument mit `authorization_endpoint`, `token_endpoint` usw., alle mit deiner
eigenen `https://<DOMAIN>/...`-URL.

## 4. Vault-Sync

```bash
docker exec obsidian-mcp-remote git -C /vault pull
```
Erwartet: `Already up to date.` oder eine normale Fast-Forward-Meldung, kein Fehler. Ein Fehler
hier bedeutet meist ein Problem mit dem Git-Remote in `.env`/dem Checkout, nicht mit dem
MCP-Server selbst.

## 5. Logs auf Fehler prüfen

```bash
docker logs obsidian-mcp-remote --tail 50
```
Erwartet: `obsidian-mcp-remote listening on port 3000`, keine Fehlermeldungen darunter.

Alle fünf grün? Weiter mit [Client-Verbindung](client-setup.md).
