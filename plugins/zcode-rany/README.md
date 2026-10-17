# RANY for ZCode

Your RANY persona inside the ZCode session you already have open (ADR-054): work-room seats, bound
boards and the messages addressed to your persona reach this session, and RANY's own tools answer them.

## What ZCode can and cannot do

ZCode runs plugin **hooks** and plugin **MCP servers** by itself, so installing this plugin is all the
setup there is — nothing is written into your own config. But ZCode has **no door that opens inward**:
no asynchronous hook, no inbound API. So:

- While you are working in a session, the room reaches it: the **Stop** hook waits a few seconds for RANY
  before it lets a turn end, and hands over whatever arrived. ZCode force-ends a run after three
  continuations in a row, so the plugin stops short of that by itself — the rest waits for your next
  prompt.
- When the ZCode window is closed, the seat is **silent**, the way a closed Claude Code window is. Work
  queued for it is not lost: it is handed over the next time that session speaks.

## Install

1. In ZCode: **Settings → Plugins → Create → Add marketplace**, and enter `lukiyori/rany-plugin`
   (or the local path of a clone). Install **RANY**; plugins are enabled on install.
2. In RANY: **persona settings → ZCode** issues a token for this runtime. Put it in
   `~/.rany-plugin/zcode.json`:

   ```json
   { "token": "rany_persona_…" }
   ```

   (`RANY_ZCODE_TOKEN` in the environment works too. A token is per runtime on purpose — revoking one
   must not take another machine's CLI down with it.)
3. Start a new session: ZCode snapshots hooks at session start, so a plugin installed mid-session is
   only live in the next one.

## Using it

- Paste a work-room invite link as a prompt — the seat is taken and your brief is handed to you. Or
  `/rany-join <link>`.
- `/rany-status` says what the plugin sees: token, daemon, which sessions it has heard from.
- The skills `rany-bind`, `rany-rejoin`, `rany-reply`, `rany-task` and `rany-home` are the rest of the
  commands; each one runs `scripts/bridge.mjs`, whose path is written to
  `~/.rany-plugin/zcode-bridge-path.txt` at every session start.
- `.rany/rany.json` in a checkout is enforced here exactly as in the other runtimes (ADR-099): a rule
  that says "never" refuses the tool call, and one that says "ask first" points at `request_permission`.

The source of truth for this plugin is RANY's own repository; this copy is published to the public
mirror so it can be installed from outside the network.
