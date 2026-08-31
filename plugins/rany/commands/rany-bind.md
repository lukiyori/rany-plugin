---
name: rany-bind
description: Claim a RANY task board's work for the repository this session is open in.
---

# Bind a task board to this repository

Argument: `<boardId>`. You do not have to go looking for it — a board id is not in any URL, so the
first unrouted task prints this command with the id already filled in.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --bind <boardId>
```

Report the line it prints, and nothing more — no summary, no next steps.

## What this decides

The plugin is installed per user, so it is live in **every** Claude Code session on this machine. A
task belongs to one repository, and nothing in the task says which. Without a binding a task
assignment cannot be routed: waking whichever session happened to start first interrupts unrelated
work with somebody else's project.

The unit is the **board**, not the server. A RANY server is a company or a community and holds many
projects; a board is the closest thing RANY has to one. (While a server has only its default board
the two coincide — which is exactly the case that would make binding the server look correct, right
up until someone adds a second board.)

Binding a board that is already bound elsewhere moves it — the last `/rany-bind` wins, deliberately,
so a moved checkout needs no file edited by hand.

An unbound board says so once per repository and then stays quiet. That is not a failure to fix
blind: run this in the repository that actually owns that work.
