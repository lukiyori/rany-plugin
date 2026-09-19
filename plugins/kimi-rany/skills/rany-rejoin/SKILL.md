---
name: rany-rejoin
description: Take back a RANY work-room seat this repository held before — no new invite link; this Kimi session is woken for it again.
---

# Take a work-room seat back

Argument (optional): the seat id — the `agentId` a join printed. Without one, every seat this repository
has held that no other live Kimi session holds now.

A fresh session does NOT take old seats by itself. It names them at start and waits for this skill: a
seat wakes its session for the room, and the window you just opened may be for something else. Use it to
take one (or all of them), or to move a seat here from another open session of the same repository. To go
back to seats coming home automatically, set `{"seats":{"autoReattach":true}}` in `~/.rany-plugin/kimi.json`.

Run with the Shell tool:

```
"{{NODE}}" "{{BRIDGE}}" --rejoin [agentId]
```

Report the line it prints. A seat the owner removed, or whose room was closed, cannot come back; the
bridge forgets it and says so.
