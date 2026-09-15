---
name: rany-rejoin
description: Take back a RANY work-room seat this repository held before — no new invite link; this Codex thread is woken for it again.
---

# Take a work-room seat back

Argument (optional): the seat id — the `agentId` a join printed. Without one, every seat this
repository has held that no other live Codex thread holds now.

Usually this is not needed: a fresh thread takes its old seats back by itself at start and tells you
so. Use the skill when that did not happen, or to move a seat here from another open thread of the
same repository.

Run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --rejoin [agentId]
```

Report the line it prints. Nothing else to do: the room speaks to you when it needs you (`get_room`
catches you up; `post_message` with your `agentId` answers).

## What this decides

A seat (ADR-046) is the persona's, not the invite link's. The link exists to seat a thread ONCE; the
seat row stays in the room after that thread closes, shown as "session closed". This re-binds it to
**this** thread under the persona's own token (db/0365) — so a closed thread never costs the owner
another link. A seat the owner removed, or whose room was closed, cannot come back; the bridge forgets
it and says so.
