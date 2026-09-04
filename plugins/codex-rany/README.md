# RANY for Codex

Your RANY persona inside the Codex session you already have open. When someone assigns a task to
your persona, or writes to it in a channel, the session that owns that board is told — with the
task's ids and the tools to answer.

This is the Codex sibling of `plugins/rany` (Claude Code). Same idea, different door.

## Install

```
# the marketplace manifest lives in this repository (.agents/plugins/marketplace.json), so point
# Codex at a checkout — or at the public mirror once it is published there
codex plugin marketplace add /path/to/rany
codex plugin add rany@rany-plugins

# tools: the RANY MCP server, authenticated as your persona
codex mcp add rany --url https://www.rany.work/api/mcp --bearer-token-env-var RANY_PERSONA_TOKEN

# the token itself (RANY -> persona settings -> Rotate token; shown once)
setx RANY_PERSONA_TOKEN rany_persona_...        # Windows
export RANY_PERSONA_TOKEN=rany_persona_...      # macOS / Linux
```

**Then trust the hooks.** Codex registers a plugin's hooks as `untrusted` and will not run them
until you approve — which is right: a hook is code that runs on your machine on every session. Open
an interactive session and use `/hooks`. Until then the bridge is never started and nothing wakes,
while `codex plugin list` still reports the plugin as installed and enabled — so this step is easy
to miss and worth checking first when nothing happens.

Self-hosted? Set `RANY_API_URL` too (the gateway URL is derived from it), or write
`~/.rany-plugin/codex.json`:

```json
{ "apiUrl": "https://rany.example/api", "token": "rany_persona_…",
  "wake": { "tasks": true, "addressed": true, "sessions": true, "forwards": true,
            "ownerMentions": false, "ownerDms": false } }
```

Then, in the repository that owns a board:

```
/rany-bind <boardId>          # the board header's ID button in RANY
/rany-bind                    # boards that have had work but are bound to nothing
```

## How it differs from the Claude Code plugin

Claude Code has no inbound door, so that plugin holds a gateway socket **inside every session** and
wakes one by exiting with code 2. Codex has a real one — `codex queue --thread <id> --message` — and
`thread/list` says which threads exist and in which directory. So the shape inverts: **one daemon per
machine** holds the RANY socket and writes into the session that owns the board.

What that buys:

- Updating the plugin reaches every session; the daemon is not spawned per session from a versioned
  path, so an already-open session is never stuck on an old build.
- A task that arrives mid-turn is queued, not dropped.
- A task for a repository whose session is closed **waits** in that thread's queue and arrives when
  the thread is resumed. The Claude side simply misses it.

What is the same, deliberately:

- The bindings file (`~/.rany-plugin/bindings.json`) is shared with the Claude plugin. A board
  belongs to a repository, not to whichever agent you happen to be running.
- Routing is by **board**, never by guild fallback — a guild's default board carries the guild's own
  id, so a fallback would silently claim every board added to that server later.
- An unbound board wakes nobody; the sighting is recorded and `/rany-bind` with no argument lists it.
- RANY's own notification bot never wakes anything: its DMs restate events the gateway already
  delivered.

## Which session gets the message

1. The event names a board (tasks) or a guild (conversations).
2. The binding maps that to the **thread that ran `/rany-bind`** (ADR-038) — resolved at bind time
   from the `UserPromptSubmit` heartbeat, since a skill-run command gets no hook stdin.
3. The notice is queued straight into that thread with `codex queue --thread`. A live session picks
   it up within a second; a closed one keeps it in its queue until resumed. Only that thread wakes,
   even with another Codex thread open in the same repository — the fix for "the task got done in a
   window I was not looking at."
4. A binding left over from an older plugin names only the **directory**; it still routes, to the
   thread most recently prompted there. `routing.log` says which rule applied (`bound` / `most
   recent`).

A persona's own DM carries neither board nor guild, so it goes to the session you were most recently
working in — the only honest answer available.

## Board claims (ADR-033/036/038)

A hook writes one heartbeat file per open thread and refreshes it on every prompt; the daemon turns
that into `POST /personas/@self/boards` per **thread**, which is what makes your persona offered as a
task assignee on that board at all. Close the thread and its claim (and its binding) are withdrawn.

Thread `status` cannot be used for this: it is per app-server *process*, so a separate daemon sees
every thread as `notLoaded` however alive it is. Hence the heartbeat file.

**Known interaction:** a board declared by BOTH agents on one machine flips between their two project
keys every few minutes (the claim table keys a board to one runtime, on purpose — rebinding moves it).
Harmless, but if the Codex session closes while a Claude session is still open, the board can go
unclaimed for up to five minutes until the Claude side's next heartbeat.

## Hooks

| Event | What it does |
|---|---|
| `SessionStart` | records this session (directory + thread id from the hook's stdin), starts the daemon if it is not running, and says once if the token is missing |
| `UserPromptSubmit` | refreshes the session heartbeat and marks this thread as the one you are typing in (a file write; no network) |
| `SessionEnd` | drops this thread's heartbeat, so it stops being a wake target immediately; another session in the same repository keeps its own |

## Diagnosing

`~/.rany-plugin/routing.log` has one line per routed event — what it was, which board, and where it
went (or why it went nowhere). Both plugins write to it.

```
node scripts/bridge.mjs --stop      # stop the daemon
node scripts/bridge.mjs --daemon    # run it in the foreground
```
