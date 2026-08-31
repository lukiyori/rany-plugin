---
name: rany-bind
description: Claim a RANY server's tasks for the repository this session is open in.
---

# Bind a RANY server to this repository

Argument: `<guildId>` — the first number in a RANY url (`/<guildId>/<channelId>`), also printed in
every wake-up notice.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --bind <guildId>
```

Report the line it prints, and nothing more — no summary, no next steps.

## What this decides

The plugin is installed per user, so it is live in **every** Claude Code session on this machine. A
task belongs to one repository, and nothing in the task says which. Without a binding a task
assignment cannot be routed: waking whichever session happened to start first interrupts unrelated
work with somebody else's project.

So each RANY server is bound to one repository, and a task from that server wakes only sessions
open there. Binding a guild that is already bound somewhere else moves it — the last `/rany-bind`
wins, deliberately, because moving a project's checkout should not need a config file edited by
hand.

An unbound guild says so once per repository, and then stays quiet. That is not a failure to fix
blind: run this in the repository that actually owns that work.
