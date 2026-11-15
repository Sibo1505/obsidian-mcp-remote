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
  that header. The scoped listener trusts no proxy: the sender is the TCP peer address, and
  forwarded headers are ignored. This is why clients must reach the scoped port **directly**, never
  through a reverse proxy.
- **Exact addresses, expiry.** A request passes only with a configured secret, from one of that
  token's exact addresses (`allowFrom`), before `expiresAt`. A wrong token, a wrong address and an
  expired token all get the same `401 {"error":"Unauthorized"}`. Only the server log says why.
- **One message per request, rate limited.** The scoped port takes one JSON-RPC message per HTTP
  request; a batch gets `400`. More than 60 requests per minute from one address get `429`
  (counted before the token check, separately from the main port).
- **Reads** see the whole vault except the `readDeny` prefixes. Denied files and folders are hidden
  from `vault_list`, rejected by `vault_read`, and left out of `search_query` (also as backlinks).
  Symlinks are resolved first, so a link cannot lead into a denied folder or out of the vault.
  Reads share one `git pull` at most every 10 seconds, so they can be up to 10 seconds behind the
  remote.
- **Search has a budget.** For a scoped token, `search_query` refuses a query larger than 8 KB,
  deeper than 20 levels or with more than 500 values; a `glob` pattern may have at most 200
  characters and braces match literally (`{a,b}` is not expanded). More than 500 matches, a result
  larger than 1 MB or more than 5 seconds of evaluation end with an error that asks to narrow the
  query, never with a silently cut list.
- **Writes** (`vault_write`, `vault_patch`) are checked by the server, not by the client:
  - only below `writeDir`, and only `.md` files;
  - every folder name matches `^[a-z0-9][a-z0-9-]*$`, the file name `^[a-z0-9][a-z0-9-]*\.md$`.
    So no dot files or dot folders (`.claude/`), no upper case, no spaces;
  - no name starting with one of the known agent instruction names (list under
    [Limits](#limits)), and no Windows device names (`con`, `prn`, `aux`, `nul`, `com0`–`com9`,
    `lpt0`–`lpt9`);
  - at most 100 characters per name, and at most 4 path parts below `writeDir`, counting folders
    and the file (`notes-inbox/a/b/c/x.md` is the deepest allowed);
  - the path must already be in plain form: no `..` or `.` path part, no `//`, no `\`;
  - no symlink anywhere on the way from the vault root to the note, and the note itself must not be
    a symlink or have other hard links. The resolved folder must lie inside
    `realpath(vault/writeDir)`;
  - at most 200 KB (UTF-8) per note; for `vault_patch` this is checked on the result;
  - at most `writesPerHour` writes per token (sliding hour).
- **Marked notes.** After every scoped write, the server sets the token's `frontmatter` fields and
  adds its `tags` in the final note, even when a write or patch tried to remove them.
- **Conflicts.** If someone else changed the same note at the same time, the server keeps the
  token's version as `<name>-conflict-<yyyymmddhhmmss>.md` next to it, under the same rules.
- **Traceable.** The commit message starts with `<name>: vault_write <path>`,
  `<name>: vault_patch <path>` or `<name>: conflict quarantined <path>`. Every request writes one
  log line, never content or the token:

  ```text
  scoped token=agent method=tools/list
  scoped token=agent tool=vault_write path="notes-inbox/today.md" result=ok
  scoped token=agent tool=vault_write path="CLAUDE.md" result=denied:outside-write-dir
  scoped token=agent tool=vault_read path="missing.md" result=error:ENOENT
  scoped auth rejected reason=address-not-allowed token=agent from=192.0.2.10
  ```

  Error answers to the client never contain server paths: system errors become fixed texts such as
  `Not found: <path>`; the error code is only in the log.
- **Fail closed.** If the scoped settings are invalid in any way, the scoped listener does not start
  and the log names the field. The main listener keeps running as before. There is never a fallback
  to wider access.

## Settings

| Variable | Meaning |
|---|---|
| `SCOPED_PORT` | Port of the scoped listener. Unset or empty: no scoped listener, nothing changes. Must differ from `PORT`. |
| `SCOPED_HOST` | Optional IP address to bind the scoped listener to. Unset or empty: **all interfaces** (the network rules below then decide who reaches it). |
| `SCOPED_TOKENS_JSON` | JSON array of token definitions (below). Not secret: it holds only the *name* of each secret's variable. |
| *one variable per token* | The secret itself, at least 32 characters, named in `tokenEnv`. Generate with `openssl rand -hex 32`. |

Fields per token (unknown fields are an error, so a typo cannot silently drop a rule):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | `[a-z0-9-]`, unique; used in logs and commit messages. |
| `tokenEnv` | yes | Name of the environment variable that holds the secret. Its **value** must differ from the values of `TOKEN_INTERNAL`, `OAUTH_CLIENT_SECRET`, `OAUTH_PASSWORD` and every other token's secret. |
| `allowFrom` | yes | Exact IP addresses (no ranges, no host names). Stored in canonical form, so `FD7A:115C:A1E0:0:0:0:0:1` and `fd7a:115c:a1e0::1` are the same address. |
| `writeDir` | yes | The one writable folder, relative to the vault, following the folder name rules above. |
| `readDeny` | no | Path prefixes (folders or files) the token cannot read: an entry covers itself and everything below it, compared without regard to case. Default: empty, so everything is readable. An entry that overlaps `writeDir` (covers it, lies inside it, or is its parent) is an error. |
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

and pass them into the container (`docker-compose.yml` already passes `SCOPED_PORT`, `SCOPED_HOST`
and `SCOPED_TOKENS_JSON`; add your secret variable next to them). With the Tailscale sidecar the
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
- **Blocked names are a known-names list.** Scoped writes refuse file and folder names that start
  with `claude`, `agent` (also `agents`), `gemini`, `qwen`, `crush`, `warp`, `copilot`, `cursor`,
  `windsurf`, `cline`, `conventions` or `readme`, in any spelling. These are the instruction and
  rules files of common coding agents (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `copilot-instructions.md`, ...); dot files and dot folders (`.cursorrules`, `.claude/`) are
  refused anyway. A tool that loads instructions from another name is not covered.
- **Notes are data.** The naming rules stop the agent from creating the files above, but the *text*
  of its notes can still contain instructions for whoever reads them later. Treat notes from a
  scoped token (marked by its `frontmatter` and `tags`) as data, not as instructions, and review
  them before moving them anywhere else. On devices that sync the vault, keep plugins that run code
  from notes off for these notes (for example Dataview JavaScript queries, or Templater's "trigger
  on new file creation").
- **Front matter is never executed.** A note whose front matter is JavaScript (`---js`) is read
  without that block (it is neither run nor returned), and scoped writes and `vault_patch` refuse
  to rewrite it. Front matter
  that is not valid YAML is read as plain text (one log line names the note).
- **Only plain names.** Scoped writes accept lowercase ASCII letters, digits and `-` only: no
  spaces, capitals or umlauts.
- **The secret lives on the agent machine.** It only works on the scoped port, from the listed
  addresses, until `expiresAt`. Rotate it by changing the secret variable and restarting.
- **Symlinks.** All checks resolve them, and on Linux the final open refuses a symlink
  (`O_NOFOLLOW`). A change to the vault folder by another process in the exact moment between check
  and write is not covered.
- **Counters are in memory.** `writesPerHour` and the request rate limit reset on restart.

---
Back to the [security notes](security.md).
