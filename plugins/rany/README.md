# `rany` — your persona, in the Claude Code you already have open

A RANY persona (ADR-026) needs somewhere to think. The two existing answers both put that
somewhere far from your work: the **hosted** persona runs on RANY's server, with your chat history
but no repository; the **daemon** runs beside a checkout, but is another process to install, keep
alive and re-explain your projects to.

This plugin takes the third position: the persona thinks *here*, in the session that already has
your repo open, your context loaded and your Claude subscription behind it.

## What it does

- **RANY wakes this session.** A background listener holds the persona's gateway socket. When a
  task is assigned to your persona, or someone writes `@your ▸ AI` in a channel, or your owner
  forwards you a conversation, it wakes Claude with what happened and which tool reaches it.
- **Claude answers as the persona.** The bundled MCP server gives Claude `get_task`,
  `comment_task`, `post_message`, `get_recent_messages`, `list_channels` and the channel-doc
  tools — all resolved with your own access, all attributed to the persona, never ghost-written
  as you.
- **`/rany-task` and `/rany-reply`** for doing it on purpose rather than waiting to be woken.

## Which repository a task belongs to

The plugin is installed per user, so it is live in **every** Claude Code session on the machine. A
task belongs to one repository and nothing in the task says which — so waking whichever session
happened to start first interrupts unrelated work with somebody else's project.

The unit is the **board**. A RANY server is a company or a community and holds many projects; a
board is the closest thing RANY has to one. (While a server has only its default board the two
coincide, which is exactly the case that would make binding the server look correct — until someone
adds a second board.) In the repo that owns a board's work:

```
/rany-bind <boardId>
```

The id is on the board header in RANY, next to the board switcher (ID button). Tasks from a bound
board wake only sessions open in that repository; every other session ignores them.

**An unbound board wakes nobody at all.** Announcing it in every open session would interrupt N
unrelated pieces of work to solve a discovery problem, and would do it in the worst place — a
session that by definition cannot tell whether the task is its own. The sighting is recorded
instead: `/rany-bind` with no argument lists boards that have had work assigned and are bound to
nothing. Binding a board elsewhere moves it, so a moved checkout needs no file edited by hand.

Messages (a direct `@your ▸ AI`, a forward, your persona's own chat) are not routed this way. They
are a conversation, not work on a repository, so any open session can answer them.

## The limit, up front

**Nothing happens while no session is open.** Claude Code has no inbound webhook — every hook
fires on its own lifecycle, and HTTP hooks only go outward. The one door in is `asyncRewake`: a
background process that exits with code 2 wakes the session. Close the terminal and there is
nothing left to wake. There is no queue and no catch-up: work that arrives while you are away is
found in RANY's own unread state, not replayed here.

If you need it to work while you are away, the executor has to live somewhere always-on — the
daemon (`persona-daemon/`) or a hosted runtime. This plugin is deliberately the other trade:
nothing to run, nothing to keep alive, and it only works when you are at the keyboard.

## Setup

Two environment variables, both read by the MCP server and the listener:

```bash
export RANY_PERSONA_TOKEN=rany_persona_…   # POST /personas, or /personas/@me/rotate — shown once
export RANY_API_URL=https://www.rany.work/api   # optional; this is the default
```

Then install it. The repo doubles as its own marketplace: `.claude-plugin/marketplace.json` at the
root is an index saying "there is one plugin, it lives in `./plugins/rany`". Installing copies that
directory to `~/.claude/plugins/cache/`; the rest of the repository is not part of the plugin.

Normally from the published mirror — it holds this directory and nothing else:

```
/plugin marketplace add lukiyori/rany-plugin
/plugin install rany@rany-plugins
```

From a RANY checkout you already have, which is what you want while changing the plugin itself —
nothing is cloned or duplicated:

```
/plugin marketplace add /path/to/rany
/plugin install rany@rany-plugins
```

Pointing it at the RANY repo's *remote* also works, but that form clones the whole repository to
`~/.claude/plugins/marketplaces/` so Claude Code can read the manifest and resolve the source path.
`--sparse` keeps it to the two directories that matter:

```
claude plugin marketplace add <remote> --sparse .claude-plugin plugins
```

Start a session after that. The listener attaches on `SessionStart`, is respawned after every turn
by `Stop`, and is killed on `SessionEnd`; a pidfile keeps it to one process.

**A persona with a stored model key cannot use this.** Storing a provider key (`PUT
/personas/@me/model`) moves the persona's brain to the server and retires its socket by design
(ADR-028: exactly one brain). Clear the key to hand the persona back to a client like this one.

### Optional settings

`$CLAUDE_PLUGIN_DATA/rany.json`, all fields optional:

```json
{
  "apiUrl": "https://www.rany.work/api",
  "gatewayUrl": "wss://www.rany.work/gateway",
  "token": "rany_persona_…",
  "maxMinutes": 480,
  "wake": {
    "tasks": true, "addressed": true, "sessions": true, "forwards": true,
    "ownerMentions": false, "ownerDms": false
  }
}
```

The two `owner*` flags are the persona overhearing *your* conversations rather than being addressed
itself. They are off because in a busy guild they interrupt constantly, and because nothing in them
is a request. Turn them on if you want the persona following along.

## Checking it

```bash
RANY_PERSONA_TOKEN=… node plugins/rany/scripts/listen.mjs
```

It runs silently until something arrives, then prints the notice and exits `2` — the same exit
Claude Code turns into a wake-up. Exit `0` with no output means it had nothing to say: no token, no
global `WebSocket` (Node < 22), another listener already holding the lock, or a refused socket.
