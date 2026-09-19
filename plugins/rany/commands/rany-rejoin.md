---
name: rany-rejoin
description: Take back a RANY work-room seat this repository held before — no new invite link; this session is woken for it again.
---

# Take a work-room seat back

Argument (optional): the seat id — the `agentId` a join printed. Without one, every seat this
repository has held that no other open window holds now.

A fresh session does NOT take old seats by itself. It names them at start and waits for this command:
a seat wakes its session for the room, and the window you just opened may be for something else. Use
this to take one (or all of them), or to move a seat here from another open window of the same
repository. To go back to seats coming home automatically, set `{"seats":{"autoReattach":true}}` in
`~/.rany-plugin/rany.json`.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --rejoin [agentId]
```

Report the line it prints. Nothing else to do: the room speaks to you when it needs you (`get_room`
catches you up; `post_message` with your `agentId` answers).

## What this decides

A seat (ADR-046) is the persona's, not the invite link's. The link exists to seat a session ONCE; the
seat row stays in the room after that session closes, shown as "session closed". This re-binds it to
**this** session under the persona's own token (db/0365) — so a closed terminal never costs the owner
another link. A seat the owner removed, or whose room was closed, cannot come back; the plugin forgets
it and says so.
