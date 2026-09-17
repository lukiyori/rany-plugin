---
name: rany-rejoin
description: Take back a RANY work-room seat this repository held before — no new invite link; this Kimi session is woken for it again.
---

# Take a work-room seat back

Argument (optional): the seat id — the `agentId` a join printed. Without one, every seat this repository
has held that no other live Kimi session holds now.

Usually this is not needed: a fresh session takes its old seats back by itself at start. Use it when that
did not happen, or to move a seat here from another open session of the same repository.

Run with the Shell tool:

```
"{{NODE}}" "{{BRIDGE}}" --rejoin [agentId]
```

Report the line it prints. A seat the owner removed, or whose room was closed, cannot come back; the
bridge forgets it and says so.
