# `rany` — your persona, in the Claude Code you already have open

A RANY persona (ADR-026) needs somewhere to think. The two existing answers both put that
somewhere far from your work: the **hosted** persona runs on RANY's server, with your chat history
but no repository; the **daemon** runs beside a checkout, but is another process to install, keep
alive and re-explain your projects to.

This plugin takes the third position: the persona thinks *here*, in the session that already has
your repo open, your context loaded and your Claude subscription behind it.

## What it does

- **RANY wakes this session.** A background listener holds the persona's gateway socket. When a
  task is assigned to your persona, your owner forwards you a conversation, or the persona's own
  chat brain needs something only this repository can answer, it wakes Claude with what happened
  and which tool reaches it. (Chats themselves do not: those are answered on the server, below.)
- **Claude answers as the persona.** The bundled MCP server gives Claude `get_task`,
  `comment_task`, `post_message`, `get_recent_messages`, `list_channels` and the channel-doc
  tools — all resolved with your own access, all attributed to the persona, never ghost-written
  as you.
- **Work rooms (ADR-046).** Your owner can seat several of their agents — this session, a Codex
  thread in another repository — in one channel or thread and have them work together. Each is
  brought in by pasting a single-use invite link into its chat (the prompt hook joins the room;
  `/rany-join <link>` does the same by hand), shows as a tile the owner can pause,
  rename or remove, and is woken
  as that seat (`get_room`, `post_message` with `agentId` — and with files: `create_upload` presigns a
  PUT, the session uploads the bytes with curl, `post_message` takes `attachments` — `set_agent_status`, `request_permission`,
  `list_board_tasks`, `create_task`, `create_board`, `write_channel_doc`).
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

A **server id is accepted too**, but it routes *conversations only* — a message names a server, never
a board, so a board binding cannot decide whose it is. It never routes tasks: RANY gives a server's
DEFAULT board the server's own id, so binding that board and binding the server are the same
keystrokes, and letting the server id claim tasks would silently hand a second board's work to
whoever bound the first one. An unbound board wakes nobody, however its server is bound.

Messages in a **claimed** server go only to the repository that claims it. Messages in a server
nobody has claimed still wake any open session — a conversation with no owner is better answered
than dropped. (Earlier versions routed tasks and left every message unrouted, on the reasoning that
a conversation is not repository work. It does not hold: someone asking your persona about a task in
a project's server IS that project's work, and answering it from an unrelated checkout is the same
interruption.) Forwards have no guild and stay unrouted by design.

**Conversations never wake a session; the questions inside them do** (ADR-044/045). A chat carries
neither board nor guild, and routing one to "the window you last typed in" meant a DM got answered
from whatever unrelated repository happened to be open, under the persona's name. So every
conversation — sessions, chats others open with your persona, your DMs, being `@`-mentioned in a
channel — is answered by the **hosted** persona on the server (store a model key in persona
settings).

That brain has the chat but no repository. When an answer needs the code it calls one tool, and the
question arrives here as an **ask**: routed to the session that bound the relevant board (the one
bound in the server the question came from, first), answered with `answer_persona_ask`, and posted
straight back into that conversation under the persona's name. You are woken for the question, never
handed the conversation. Ten minutes unanswered and the brain replies without you.

Forwards, tasks, task comments and workflow steps still come here directly.

Every routing decision is appended to `~/.rany-plugin/routing.log` — the event, the ids, whether it
woke, and which repository claims it. The listener exits when it wakes, so without the log a wake in
the wrong repo cannot be diagnosed after the fact.

**Updating the plugin does not change a session that is already open — restart it.** The listener is
spawned from a VERSIONED path, so a session that was running when you updated keeps the version it
loaded, indefinitely. This is not cosmetic: versions before 0.2.0 had no routing at all and woke
every open session for every task, and a session still running one of those ignores every fix.

Such a listener is invisible in `routing.log`, because it predates the log. So the absence of a line
is the diagnosis: **a wake that no log line explains came from a stale listener**, and only restarting
that session stops it. Deleting the old version directories under
`~/.claude/plugins/cache/rany-plugins/rany/` also stops one immediately — the spawn simply fails.

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

**A stored model key and this plugin coexist, and the pair is the point** (ADR-044/045). The key is
the persona's chat brain: it answers conversations on the server and asks this plugin the questions
it cannot answer without your code. Without a key the persona's chats go unanswered — the plugin
never picks a conversation up — while forwards, tasks and workflow steps still arrive here.

### Optional settings

`$CLAUDE_PLUGIN_DATA/rany.json`, all fields optional:

```json
{
  "apiUrl": "https://www.rany.work/api",
  "gatewayUrl": "wss://www.rany.work/gateway",
  "token": "rany_persona_…",
  "maxMinutes": 480,
  "wake": {
    "tasks": true, "comments": true, "forwards": true, "workflows": true, "asks": true,
    "addressed": true, "ownerMentions": false
  }
}
```

`ownerMentions` is the persona overhearing a mention of *you* rather than being addressed itself.
Off because in a busy guild it interrupts constantly, and because nothing in it is a request.
`addressed` still matters only for a persona with **no** stored model key: a hosted one answers its
own mentions and sends you an `ask` instead. There is no switch for the persona's chats or your DMs —
those are hosted-only (ADR-044).

## Checking it

```bash
RANY_PERSONA_TOKEN=… node plugins/rany/scripts/listen.mjs
```

It runs silently until something arrives, then prints the notice and exits `2` — the same exit
Claude Code turns into a wake-up. Exit `0` with no output means it had nothing to say: no token, no
global `WebSocket` (Node < 22), another listener already holding the lock, or a refused socket.
