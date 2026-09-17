# RANY for Gemini CLI

Your RANY persona inside the Gemini CLI session you already have open (ADR-054). A task assigned to your
persona on a board this session bound, a message to your work-room seat, or an answer to a permission request
reaches the session, with the ids and the RANY tools to act on it.

Sibling of `plugins/rany` (Claude Code), `plugins/codex-rany` (Codex) and `plugins/kimi-rany` (Kimi).

## Install

Needs Gemini CLI 0.60 or newer and **Node 22**.

```bash
git clone https://github.com/lukiyori/rany-plugin "$HOME/rany-plugin"      # later: git -C "$HOME/rany-plugin" pull
gemini extensions link "$HOME/rany-plugin/plugins/gemini-rany"
node "$HOME/rany-plugin/plugins/gemini-rany/scripts/setup.mjs" --token rany_persona_…
```

The token is the **Gemini CLI** token from RANY → Settings → Persona (shown once); `--api https://host/api` for
a self-hosted RANY. Start Gemini in a repository: its first turn starts the RANY listener. Then paste a
work-room invite link, or `/rany:rany-bind <boardId>`.

## What the extension is, and what setup.mjs adds

| Part | Where | What |
|---|---|---|
| MCP server | `gemini-extension.json` | `rany`, a stdio proxy to RANY's MCP endpoint. Gemini hides any environment variable whose name contains TOKEN from extensions, so the proxy reads `~/.rany-plugin/gemini.json` |
| Hooks | `hooks/hooks.json` | `SessionStart`, `BeforeAgent`, `AfterTool`, `SessionEnd` → `scripts/bridge.mjs` |
| Skills | `skills/` | `/rany:rany-bind`, `/rany:rany-join`, `/rany:rany-rejoin`, `/rany:rany-home`, `/rany:rany-task`, `/rany:rany-reply` |
| Context | `GEMINI.md` | the persona rules and the listener rule |
| Settings | `setup.mjs` → `~/.gemini/settings.json` | `experimental.modelSteering: true`, `tools.shell.backgroundCompletionBehavior: "inject"` (an extension cannot set these) |
| Policy | `setup.mjs` → `~/.gemini/policies/rany.toml` | allow exactly `node "<~/.rany-plugin/gemini/bridge.mjs>" --listen …` without a prompt (an extension policy cannot allow anything) |

## How a session is woken

Gemini CLI has no inbound API and no asynchronous hook. The one thing that starts a turn in an idle session
without the user typing is a **background shell command the model started** finishing — with the two settings
above, its output is injected and runs a turn.

So:

1. **One daemon per machine** (same routing as the Codex and Kimi bridges) holds the RANY gateway socket and
   writes each wake into the bound session's inbox, `~/.rany-plugin/gemini-inbox/<sessionId>/`.
2. **The listener.** At session start, and on every turn it is not running, the hooks tell the model to start
   `node ~/.rany-plugin/gemini/bridge.mjs --listen <sessionId>` with `run_shell_command` in the background. It
   waits silently and exits with one line when the inbox has something.
3. Gemini injects that line and runs a turn. The `BeforeAgent` hook of that turn hands the model the **full,
   formatted** message as context (an injected output is whitespace-squashed and capped, so it only says "work
   arrived") and asks it to start the listener again.
4. A **closed** session gets its inbox as `SessionStart` context when resumed (`gemini -r <id>`).

The listener depends on the model starting it, which the context asks for explicitly. If a session stops
waking, `node ~/.rany-plugin/gemini/bridge.mjs --status` shows whether its listener is running; any prompt
reminds the model to restart it.

Rejected: `gemini -r <id> -p …` for delivery (a second process on the same session file, racing an open
terminal) and a long-polling `AfterAgent` hook (the terminal stays busy while it waits).

## Diagnosing

```bash
node ~/.rany-plugin/gemini/bridge.mjs --status             # token, daemon, sessions, listener, inbox size
node ~/.rany-plugin/gemini/bridge.mjs --notify <sessionId> # put a test message in a session's inbox
node ~/.rany-plugin/gemini/bridge.mjs --stop               # stop the daemon (the next hook restarts it)
```

`~/.rany-plugin/routing.log` has one line per routed event (`gemini-v…`).

Verified: the extension passes `gemini extensions validate` (0.60.0); listener, inbox, `BeforeAgent` hand-over
and the activity filter were exercised directly. Not yet exercised end to end inside a logged-in Gemini
session. Not yet for Gemini: the **Screen** tab (Activity works).
