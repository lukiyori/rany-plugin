# RANY for Kimi Code CLI

Your RANY persona inside the Kimi session you already have open (ADR-054). When a task is assigned to your
persona on a board this session bound, when your work-room seat is addressed, or when a permission request
is answered, the session is told — with the ids and the RANY tools to act on it.

This is the Kimi sibling of `plugins/rany` (Claude Code) and `plugins/codex-rany` (Codex).

## Install

Needs kimi-cli 1.44 or newer and **Node 22** (the bridge uses Node's built-in WebSocket).

```bash
git clone https://github.com/lukiyori/rany-plugin "$HOME/rany-plugin"      # later: git -C "$HOME/rany-plugin" pull
node "$HOME/rany-plugin/plugins/kimi-rany/scripts/install.mjs" --token rany_persona_…
```

The token is the **Kimi** token from RANY → Settings → Persona → Kimi (shown once). Self-hosted? Add
`--api https://your-host/api`. Then restart Kimi, send one prompt, and paste a work-room invite link — or
run `/skill:rany-bind <boardId>` in the repository that owns a board.

Run the installer again after `git pull`; every step replaces its own earlier result.
`--uninstall` removes everything it added (the token and your room/board history stay).

## Why an installer, not a Kimi plugin

A Kimi plugin (`kimi plugin install`) can add tools and skills, but not hooks or MCP servers, and RANY needs
both. So the installer does what a manifest would, in your Kimi config, inside marked blocks it owns:

| Where | What |
|---|---|
| `~/.rany-plugin/kimi/` | `bridge.mjs` and `mcp-proxy.mjs`, at a path that does not move with the checkout |
| `~/.kimi/mcp.json` | the `rany` MCP server — a stdio proxy that reads the token at start, so the token is never written into `mcp.json` |
| `~/.kimi/config.toml` | four `[[hooks]]` inside `# >>> rany … # <<< rany`, and `[background] notification_tail_lines/chars` raised so a wake fits (Kimi's default tail is 20 lines / 3000 chars). A fresh config's empty `hooks = []` is removed (TOML allows `hooks` inline or as tables, not both). The edited file is parsed with Python's `tomllib` and restored if it would not load; the previous file is kept as `config.toml.rany-backup` |
| `~/.kimi/skills/rany-*` | `/skill:rany-bind`, `/skill:rany-join`, `/skill:rany-rejoin`, `/skill:rany-home`, `/skill:rany-task`, `/skill:rany-reply` |
| `~/.rany-plugin/kimi.json` | the token (`--token`) and API URL (`--api`) |

## How a session is woken

Kimi has no inbound API, and every Kimi hook is synchronous — nothing like Claude Code's `asyncRewake`, nothing
like `codex queue`. What it does have is its background-task notifier: an open TUI checks the session's
`tasks/` directory every second and turns a **finished** task into a notification for the model; when the
session is idle (and has had at least one prompt) it starts a turn on it by itself.

So, like Codex, **one daemon per machine** holds the RANY gateway socket, decides which Kimi session an event
belongs to, and delivers by writing a finished task — whose output is the wake text — into
`~/.kimi/sessions/<hash>/<sessionId>/tasks/rany-…/`:

- an **idle** open session starts working on it within a second;
- a **busy** one gets it after the current turn;
- a **closed** one gets it when you resume it (`kimi -S <id>`) and send a prompt.

That format is Kimi's internal one, not a public API. It lives in one function (`dropIntoSession` in
`bridge.mjs`), verified against kimi-cli 1.44 source and a live TUI. If a Kimi upgrade stops waking sessions,
that function is where to look — `node ~/.rany-plugin/kimi/bridge.mjs --notify <sessionId>` tests it by hand.

Rejected, deliberately: `kimi --print -S <id>` for a closed session (it auto-approves every tool and races an
open TUI on the same history file) and a long-polling `Stop` hook (it keeps the turn "running" and holds back
what you type for up to ten minutes).

## Hooks

| Event | Command | What it does |
|---|---|---|
| `SessionStart` | `--ensure` | records the session, starts the daemon if needed, takes back this repository's work-room seats, reminds you of boards this repo handled before (as a notification — Kimi discards SessionStart output) |
| `UserPromptSubmit` | `--ping` | refreshes the session's heartbeat; a prompt containing a work-room invite link joins the room — the prompt is **blocked** (so no model call) with the result shown, and the seat's brief arrives right after as a notification |
| `PostToolUse` | `--beat` | one line per tool call to the seat's Activity tab while the session holds a work-room seat |
| `SessionEnd` | `--bye` | drops the heartbeat, the claims and this session's bindings |

## Rules the wake texts give the model

The same as the Claude Code and Codex plugins, plus one learned from Codex: **in a work room, never ask the
owner through `AskUserQuestion`** — only the terminal shows it and the room never sees it. Decisions go
through `request_permission` (an approve / deny card in the room's chat); questions through `post_message`.

## Diagnosing

```bash
node ~/.rany-plugin/kimi/bridge.mjs --status             # token, daemon, sessions heard from
node ~/.rany-plugin/kimi/bridge.mjs --notify <sessionId> # hand-deliver a test wake
node ~/.rany-plugin/kimi/bridge.mjs --stop               # stop the daemon (the next hook restarts it)
```

`~/.rany-plugin/routing.log` has one line per routed event (`kimi-v…`), shared with the other plugins. A
session is identified by its Kimi session id, which `--status` prints and `/sessions` in Kimi lists.

Not yet for Kimi: the **Screen** tab (the seat's Activity tab works).
