# Scoped tokens

Optional. A scoped token lets an agent on another machine in your tailnet **read the vault and
write either to exactly one folder, or anywhere except the paths you deny**. Typical cases: an agent
on a server reads your notes and rules and files its own notes in an inbox folder, without being
able to change anything else (`writeDir: "notes-inbox"`); or it may put new notes where they
belong and change only the notes it wrote, but never touch agent configuration or your rule notes
(`writeDir: "/"` with `writeDeny`).

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
  An entry also covers its namesake: `projects/plan.md` covers the folder `projects/plan/`, and
  `resources/ops` covers the note `resources/ops.md` (a hub note and its folder belong together).
  Symlinks are resolved first, so a link cannot lead into a denied folder or out of the vault.
  Reads share one `git pull` at most every 10 seconds, so they can be up to 10 seconds behind the
  remote.
- **Search has a budget.** For a scoped token, `search_query` refuses a query larger than 8 KB,
  deeper than 20 levels or with more than 500 values; a `glob` pattern may have at most 200
  characters and braces match literally (`{a,b}` is not expanded). More than 500 matches, a result
  larger than 1 MB or more than 5 seconds for reading and evaluating the notes (checked between
  notes) end with an error that asks to narrow the query, never with a silently cut list.
- **Search runs in its own thread.** A scoped search runs in a worker thread with a memory ceiling
  (256 MB) and is stopped after 10 seconds whatever it is doing, also inside a single slow regular
  expression. Only one scoped search runs at a time; a second one gets an error ("Another search is
  still running") instead of waiting. The server itself, and with it the main port, keeps answering.
  That one slot is shared by all scoped tokens: a client that sends an expensive search every
  10 seconds keeps it (and one CPU core) busy, and other scoped tokens get that error meanwhile.
- **Results have a ceiling.** Every scoped result may have at most about 2 MB as JSON and 100 000
  values. The server measures that before it builds the answer, counting a YAML alias (`*name`)
  every time it is used, so a small note whose front matter expands to millions of values is
  refused instead of being expanded. `vault_read` refuses a file over 2 MB before reading it.
- **Writes** (`vault_write`, `vault_patch`) are checked by the server, not by the client:
  - only below `writeDir`; with `writeDir: "/"` anywhere in the vault. Never into a `writeDeny` or
    `readDeny` path (compared without regard to case, namesakes included as for reads);
  - every part of the path, existing or not: no dot files or dot folders (`.claude/`,
    `.obsidian/`), no characters some OS cannot store (`<>:"|?*`, control characters, a trailing
    space or dot), only `.md` notes, no name starting with one of the known agent instruction names
    (list under [Limits](#limits)) and no Windows device names (`con`, `prn`, `aux`, `nul`,
    `com0`–`com9`, `lpt0`–`lpt9`). So folders like `claude-skills/` stay unwritable without any
    `writeDeny` entry;
  - **whatever the write creates** (new folders and a new note) must match `^[a-z0-9][a-z0-9-]*$`
    (folders) and `^[a-z0-9][a-z0-9-]*\.md$` (notes): no upper case, no spaces. Existing folders
    and notes keep their names, so with `writeDir: "/"` a token can write `Projects/x.md` or
    update `My Notes/Idea.md`, but cannot create `Projects/My Idea.md`;
  - a new name must not differ from an existing sibling only in case (`notes.md` next to
    `Notes.md`): on the case-insensitive file systems the vault syncs to, both would be one file;
  - at most 100 characters per name. With one write folder at most 4 path parts below `writeDir`,
    counting folders and the file (`notes-inbox/a/b/c/x.md` is the deepest allowed); with
    `writeDir: "/"` at most 10 path parts and at most 3 new folders per write;
  - at most 170 characters for the whole vault-relative path, existing folders included. Windows
    allows 260 characters for a path, the vault folder included, and Git for Windows stops a pull
    at a longer one. A conflict copy (below) may use up to 200;
  - the path must already be in plain form: no `..` or `.` path part, no `//`, no `\`, no leading `/`;
  - all of this is checked before anything is created: a rejected write leaves no empty folders;
  - no symlink anywhere on the way from the vault root to the note, and the note itself must not be
    a symlink or have other hard links. The resolved folder must lie inside
    `realpath(vault/writeDir)`;
  - **only its own existing notes** with `modifyExisting: "own"`, the default for `writeDir: "/"`.
    With the whole vault writable, a token creates notes anywhere but changes only notes that carry
    its own front matter. Set `modifyExisting: "any"` to allow more. A note is the token's own when
    it carries every one of the token's `frontmatter` fields with exactly that value and type
    (`false` is not `"false"`). A note without front matter, with other values, or with front
    matter that is not valid YAML belongs to someone else: `vault_write` and every `vault_patch`
    refuse it (`denied:foreign-note`) and ask the client to create a new note and link to it.
    The server reads the existing note without following a symlink and only up to 2 MB, and the
    check, the write and the commit run under one lock, so no pull can bring in another version of
    the note in between. Once a person removes the token's fields from a note, the note is theirs
    and the token can no longer change it;
  - at most 200 KB (UTF-8) per note; for `vault_patch` this is checked on the result;
  - no front matter that reuses a list or mapping through a YAML alias (`*name`), and none with
    more than 10 000 values or about 2 MB once written out (one long text reused through an alias
    counts in full every time, and so does every list and mapping): a few hundred bytes of aliases
    can stand for billions of values for every later reader, and writing YAML takes time that grows
    with the square of the number of lists and mappings. `vault_patch` checks the existing note's
    front matter and, for a front matter patch, the new value the same way before it patches;
  - at most `writesPerHour` write attempts per token (sliding hour). A `vault_write` counts once
    its path passes the checks on the text (write folder, deny lists, the names of every part,
    length) and the note passes the size limit; a `vault_patch` counts once the note is found and
    read. Every refusal after that point counts too: a new name that is not plain, a case twin, a
    symlink on the way, an existing note the token did not write, the front matter, a missing
    heading, the size of the patched note.
- **Marked notes.** After every scoped write, the server sets the token's `frontmatter` fields and
  adds its `tags` in the final note, even when a write or patch tried to remove them. With
  `modifyExisting: "own"` these fields also decide which existing notes the token may change later.
- **Conflicts.** If someone else changed the same note at the same time, the server keeps the
  token's version as `<name>-conflict-<yyyymmddhhmmss>.md` next to it, under the same rules: with
  `modifyExisting: "own"` a copy never replaces a note the token did not write. The name is reduced
  to a plain one first (`My Idea.md` → `my-idea-conflict-….md`).
- **Traceable.** The commit message starts with `<name>: vault_write <path>`,
  `<name>: vault_patch <path>` or `<name>: conflict quarantined <path>`. Every request writes one
  log line, never content or the token. A tool call that is refused before its tool runs (invalid
  arguments, or a client that does not accept the answer's format) gets a `result=rejected` line.
  Paths longer than 300 characters are cut in the log:

  ```text
  scoped token=agent method=tools/list
  scoped token=agent tool=vault_write path="notes-inbox/today.md" result=ok
  scoped token=agent tool=vault_write path="CLAUDE.md" result=denied:outside-write-dir
  scoped token=agent tool=vault_patch path="rules/house-rules.md" result=denied:write-denied
  scoped token=agent tool=vault_read path="missing.md" result=error:ENOENT
  scoped token=agent method=tools/call tool=vault_write result=rejected
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
| `writeDir` | yes | The one writable folder, relative to the vault, following the folder name rules above; or exactly `"/"` for the whole vault. An empty value is an error, never "everything". |
| `writeDeny` | no | Path prefixes (folders or files) the token cannot write, like `readDeny`. Default: empty. Mainly for `writeDir: "/"`: list what the vault's devices treat as rules or configuration. The tool descriptions never list these entries; a denied write says so when it happens. |
| `readDeny` | no | Path prefixes (folders or files) the token cannot read: an entry covers itself, everything below it and its namesake (`x.md` and `x/`), compared without regard to case. Default: empty, so everything is readable. Every entry is write-denied as well. With one write folder, an entry that overlaps `writeDir` (covers it, lies inside it, or is its parent) is an error. |
| `expiresAt` | yes | ISO date (`2026-12-31`, meaning 00:00 UTC) or date-time with offset (`2026-12-31T23:59:00Z`). After that: 401 and a log line. |
| `writesPerHour` | no | Default 60. Counts write attempts, also refused ones, from the point described above. With `writeDir: "/"`, set it well below the default, to what the agent really needs: it caps how many notes a misled agent can write in an hour. |
| `frontmatter` | no | Fields the server sets on every note it writes for this token (strings, numbers, booleans; not `tags`). With `modifyExisting: "own"` they also mark the notes the token may change. |
| `tags` | no | Tags the server adds to every note it writes for this token. |
| `modifyExisting` | no | `"own"`: change only existing notes that carry every `frontmatter` field of this token with exactly that value; `"any"`: every writable note. Default `"own"` with `writeDir: "/"`, `"any"` with one write folder. `"own"` needs at least one `frontmatter` field, otherwise the scoped listener does not start. New notes are allowed either way. |

Example (`.env`; the single quotes keep the JSON in one piece):

```bash
SCOPED_PORT=3001
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"notes-inbox","readDeny":["private/"],"expiresAt":"2026-12-31","writesPerHour":60,"frontmatter":{"source":"agent"},"tags":["agent"]}]'
TOKEN_AGENT=<openssl rand -hex 32>
```

The same token for the whole vault, keeping it out of a rules folder and one note:

```bash
SCOPED_TOKENS_JSON='[{"name":"agent","tokenEnv":"TOKEN_AGENT","allowFrom":["100.64.0.10"],"writeDir":"/","writeDeny":["rules/","projects/house-rules.md"],"readDeny":["private/"],"expiresAt":"2026-12-31","frontmatter":{"source":"agent"},"tags":["agent"]}]'
```

It changes only the existing notes it wrote (`modifyExisting` defaults to `"own"`, recognized by
`"source":"agent"`).

and pass them into the container (`docker-compose.yml` already passes `SCOPED_PORT`, `SCOPED_HOST`
and `SCOPED_TOKENS_JSON`; add your secret variable next to them). With the Tailscale sidecar the
container is reachable on its tailnet address, so **do not** add a `ports:` mapping for the scoped
port.

On the agent machine, send the secret as `Authorization: Bearer <secret>` to
`http://<server tailnet address>:3001/mcp`.

## What to deny

With `writeDir: "/"`, the deny lists decide what an agent cannot reach. "Only its own notes" keeps
it from changing your existing notes, but it can still put a *new* note into any folder that is not
denied, and whoever reads that folder later sees it. Put these into `writeDeny` (or `readDeny`,
which denies writing as well):

- folders whose notes agents read as rules or briefings: instructions kept as notes, a folder an
  agent works off as tasks, an inbox another agent processes;
- folders with templates: a template is copied into new notes, so its text spreads;
- knowledge bases of skills or tools: reference notes an agent loads before it acts;
- project plans and decision logs that people or agents follow;
- every note or folder from which an agent takes commands, settings or code.

Reading a note by section (`vault_read` with `targetType: "heading"`) returns only that section,
not the note's front matter. A reader that reads only a section therefore does not see the marks
that tell a scoped token's note from yours. Agents that read sections of notes a scoped token could
have written should read the marking field first (`targetType: "frontmatter"`, `target: "source"`).

At start, the server logs every deny entry that matches nothing in the vault, for example
`Scoped token "agent": writeDeny entry "rule" matches nothing in the vault (a typo?)`. Such an
entry protects nothing until that path exists. The line goes to the server log only, never to a
client.

## Undoing a token's writes

Every write of a scoped token is one commit whose message starts with the token's name. To find
and undo them in a clone of the vault:

```bash
# every commit of the token "agent", newest first
git log --grep '^agent: ' --format='%h %ad %s' --date=iso
# undo one
git revert --no-edit <commit>
# undo everything since a date (newest first, so later changes go first)
git log --grep '^agent: ' --since=2026-12-01 --format=%H | xargs git revert --no-edit
git push
```

Check the list before you undo it: `--grep` matches every commit with a message line that starts
like that. If a note changed again after the token's commit, `git revert` stops with a conflict for
that note; resolve it, then run `git revert --continue`.

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
  that is not valid YAML is read as plain text (one log line names the note). A block that is not
  a mapping (a sentence, a number, a list between two `---` lines) is not front matter either: the
  note is read and written as plain text.
- **Writing the whole vault is a deny list.** With `writeDir: "/"`, a new folder is writable until
  you list it. The name rules keep agent configuration out (dot folders, `claude*`, `agents*`, ...),
  and "only its own notes" keeps your existing notes as they are, but a new note can still land in
  a folder that people or agents on other devices *treat* as rules (a "house rules" folder, a
  project's decision log). Put those in `writeDeny` (see [What to deny](#what-to-deny)). Every note
  the token writes gets its `frontmatter` and `tags`, so you can see afterwards which notes are
  its own.
- **Only plain new names.** Folders and notes a scoped token creates use lowercase ASCII letters,
  digits and `-` only: no spaces, capitals or umlauts. Existing names stay as they are.
- **The secret lives on the agent machine.** It only works on the scoped port, from the listed
  addresses, until `expiresAt`. Rotate it by changing the secret variable and restarting.
- **Symlinks.** All checks resolve them, and on Linux the final open refuses a symlink
  (`O_NOFOLLOW`). A change to the vault folder by another process in the exact moment between check
  and write is not covered.
- **Counters are in memory.** `writesPerHour` and the request rate limit reset on restart.

---
Back to the [security notes](security.md).
