# Scoped tokens

Optional. A scoped token lets an agent on another machine in your tailnet **read the vault and
write to exactly one folder**. A typical case: an agent on a server should read your notes and
rules, and file its own notes in an inbox folder, without being able to change anything else.

Scoped tokens use their **own listener on their own port**. The main listener (`PORT`, OAuth and
`TOKEN_INTERNAL`) stays exactly as it is.

## How it works

- **Own port, own app.** With `SCOPED_PORT` set, the server starts a second listener. It only has
  `POST /mcp` (the same five tools) and `GET /health`. There are no OAuth routes, no login pages
  and no static files there, and `TOKEN_INTERNAL` and OAuth tokens are not accepted.
- **No proxy trust.** The main listener trusts one reverse-proxy hop, so it reads the client
  address from `X-Forwarded-For`. Anyone who reaches that port directly can claim any address in
  that header. The scoped listener trusts no proxy: the sender is the TCP peer address
  (`::ffff:` removed), and forwarded headers are ignored. This is why clients must reach the
  scoped port **directly**, never through a reverse proxy.
- **Exact addresses, expiry.** A request passes only with a configured secret, from one of that
  token's exact addresses (`allowFrom`), before `expiresAt`. A wrong token, a wrong address and an
  expired token all get the same `401 {"error":"Unauthorized"}`. Only the server log says why.
- **Reads** see the whole vault except the `readDeny` prefixes. Denied files and folders are hidden
  from `vault_list`, rejected by `vault_read`, and left out of `search_query` (also as backlinks).
  Symlinks are resolved first, so a link cannot lead into a denied folder or out of the vault.
- **Writes** (`vault_write`, `vault_patch`) are checked by the server, not by the client:
  - only below `writeDir`, and only `.md` files;
  - every folder name matches `^[a-z0-9][a-z0-9-]*$`, the file name `^[a-z0-9][a-z0-9-]*\.md$`.
    So no dot files or dot folders (`.claude/`), no upper case, no spaces;
  - no name starting with `claude` or `agents` (`CLAUDE.md`, `claude-notes.md`, `agents.md` in
    any spelling), no Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
    `lpt1`–`lpt9`);
  - at most 100 characters per name, at most 4 levels below `writeDir`;
  - the path must already be in plain form: no `..`, `.`, `//` or `\`;
  - no symlink anywhere on the way from the vault root to the note, and the note itself must not be
    a symlink or have other hard links. The resolved folder must lie inside
    `realpath(vault/writeDir)`;
  - at most 200 KB (UTF-8) per note; for `vault_patch` this is checked on the result;
  - at most `writesPerHour` writes per token (sliding hour).
- **Marked notes.** After every scoped write, the server sets the token's `frontmatter` fields and
  adds its `tags` in the final note, even when a write or patch tried to remove them.
- **Traceable.** The commit message starts with `<name>: vault_write <path>` or
  `<name>: vault_patch <path>`. Every tool call writes one log line, never content or the token:

  ```text
  scoped token=agent tool=vault_write path="notes-inbox/today.md" result=ok
  scoped token=agent tool=vault_write path="CLAUDE.md" result=denied:outside-write-dir
  scoped auth rejected reason=address-not-allowed token=agent from=192.0.2.10
  ```

- **Fail closed.** If the scoped settings are invalid in any way, the scoped listener does not start
  and the log says why. The main listener keeps running as before. There is never a fallback to
  wider access.

## Settings

| Variable | Meaning |
|---|---|
| `SCOPED_PORT` | Port of the scoped listener. Unset or empty: no scoped listener, nothing changes. Must differ from `PORT`. |
| `SCOPED_TOKENS_JSON` | JSON array of token definitions (below). Not secret: it holds only the *name* of each secret's variable. |
| *one variable per token* | The secret itself, at least 32 characters, named in `tokenEnv`. Generate with `openssl rand -hex 32`. |

Fields per token (unknown fields are an error, so a typo cannot silently drop a rule):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | `[a-z0-9-]`, used in logs and commit messages. |
| `tokenEnv` | yes | Name of the environment variable that holds the secret. It must differ from `TOKEN_INTERNAL` and the OAuth secrets, and from other tokens' secrets. |
| `allowFrom` | yes | Exact IP addresses (no ranges, no host names). |
| `writeDir` | yes | The one writable folder, relative to the vault, following the folder name rules above. |
| `readDeny` | no | Path prefixes (folders or files) the token cannot read. Default: empty, so everything is readable. |
| `expiresAt` | yes | ISO date (`2026-12-31`, meaning 00:00 UTC) or date-time with offset (`2026-12-31T23:59:00Z`). After that: 401 and a log line. |
| `writesPerHour` | no | Default 60. |
| `frontmatter` | no | Fields the server sets on every note it writes for this token (strings, numbers, booleans; not `tags`). |
| `tags` | no | Tags the server adds to every note it writes for this token. |

Example (`.env`; the single quotes keep the JSON in one piece):

```bash
SCOPED_PORT=3001
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"notes-inbox","readDeny":["private/"],"expiresAt":"2026-12-31","writesPerHour":60,"frontmatter":{"source":"agent"},"tags":["agent"]}]'
TOKEN_AGENT=<openssl rand -hex 32>
```

and pass all three into the container (`docker-compose.yml` already passes `SCOPED_PORT` and
`SCOPED_TOKENS_JSON`; add your secret variable next to them). With the Tailscale sidecar the
container is reachable on its tailnet address, so **do not** add a `ports:` mapping for the scoped
port.

On the agent machine, send the secret as `Authorization: Bearer <secret>` to
`http://<server tailnet address>:3001/mcp`.

## Network rules

The token check is one layer; the network should be the other:

- Allow the agent machine **only** the scoped port of this server in your tailnet policy, for
  example (tags are placeholders):

  ```json
  { "action": "accept", "src": ["tag:agent"], "dst": ["tag:vault-server:3001"] }
  ```

- Never give that machine the main port (`PORT`). Its OAuth login page and `TOKEN_INTERNAL` are
  not meant for it, and that port trusts `X-Forwarded-For`.
- Never put the scoped port behind a reverse proxy: every request would then come from the proxy's
  address, and `allowFrom` could no longer tell machines apart.

## Limits

- **Reading is broad.** By default the token reads everything that is not in `readDeny`. It is a
  deny list, so new folders are readable by default. An agent that reads untrusted text (web pages,
  issues, mail) can be tricked into sending what it read elsewhere. Git protects against unwanted
  changes, not against data leaving. Keep private material in `readDeny`, or keep it out of this
  vault.
- **Notes are data.** The naming rules stop the agent from creating instruction or config files,
  but the *text* of its notes can still contain instructions for whoever reads them later. Treat
  notes from a scoped token (marked by its `frontmatter` and `tags`) as data, not as instructions,
  and review them before moving them anywhere else.
- **The secret lives on the agent machine.** It only works on the scoped port, from the listed
  addresses, until `expiresAt`. Rotate it by changing the secret variable and restarting.
- **Symlinks.** All checks resolve them, and on Linux the final open refuses a symlink
  (`O_NOFOLLOW`). A change to the vault folder by another process in the exact moment between check
  and write is not covered.
- **Counters are in memory.** `writesPerHour` and the request rate limit reset on restart.

---
Back to the [security notes](security.md).
