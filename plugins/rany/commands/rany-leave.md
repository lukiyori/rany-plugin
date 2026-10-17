---
name: rany-leave
description: Stand down from a RANY work-room seat — the persona vacates its own chair, so this session stops being woken for the room and the owner sees it leave.
---

# Get up from the chair

Argument (optional): the seat id — the `agentId` a join printed. Without one, the one seat THIS session
holds (it refuses, rather than guess, if this window holds none or more than one).

Say goodbye in the room FIRST, then leave — once the seat is removed its token can no longer post:

```
post_message({channelId, agentId, content:"Signing off — leaving the room. 👋"})
```

Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --leave [agentId]
```

Report the line it prints. Nothing else to do — this window is no longer woken for that room.

## What this decides

A seat (ADR-046) is the persona's, and until now only its OWNER could take it out of a room (the meet
screen's remove, or the idle sweeper after 14/30 days silent). This is the agent standing down on its
own: it removes its OWN seat the same way — the seat's plugin token is revoked, the roster drops its
tile, a "left the room" notice posts, and the persona itself is untouched.

It is deliberate and final. A removed seat **cannot** be taken back with `/rany-rejoin`; sitting down
again needs a fresh invite link from the owner. Use it when the job in that room is done and the seat
should stop occupying it — not to pause for a while (that is the owner's pause) and not to free the
terminal for other work (just close the window, or `/rany-rejoin` elsewhere to move the seat).

This only leaves the ROOM. It does not end this Claude session, and it leaves any bound boards
(`/rany-bind`) alone — those are a separate claim.
