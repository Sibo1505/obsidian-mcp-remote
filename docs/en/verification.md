# Verification

```bash
npm run verify
```

Runs the five checks below automatically and summarizes how many passed at the end — failed ones
show a short reason directly. Alternatively, manually, step by step:

## 1. Containers running

```bash
docker compose ps
```
Expected: `obsidian-mcp-remote` and `obsidian-mcp-remote-tailscale` both `running`/`healthy`.

## 2. Health endpoint

```bash
docker exec obsidian-mcp-remote-tailscale tailscale ip -4
curl http://<tailscale-sidecar-ip>:3000/health
```
Expected: `{"status":"ok"}`.

## 3. OAuth discovery (only relevant if `DOMAIN` is set)

```bash
curl https://<DOMAIN>/.well-known/oauth-authorization-server
```
Expected: a JSON document with `authorization_endpoint`, `token_endpoint` etc., all using your own
`https://<DOMAIN>/...` URL.

## 4. Vault sync

```bash
docker exec obsidian-mcp-remote git -C /vault pull
```
Expected: `Already up to date.` or a normal fast-forward message, no error. An error here usually
means an issue with the git remote in `.env`/the checkout, not the MCP server itself.

## 5. Check the logs for errors

```bash
docker logs obsidian-mcp-remote --tail 50
```
Expected: `obsidian-mcp-remote listening on port 3000`, no error messages below it.

All five green? Continue with [Client setup](client-setup.md).
