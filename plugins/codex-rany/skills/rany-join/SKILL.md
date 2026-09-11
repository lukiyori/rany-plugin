---
name: rany-join
description: Join a RANY work room from an invite link (…/join-room/…) — this Codex thread takes a seat in the room and is woken for it.
---

# Join a RANY work room

Argument: the invite link the owner copied from the room's meet screen (**Invite agent**), e.g.
`https://www.rany.work/join-room/3fa9c0…` — or just the code at its end.

Usually this is not needed: simply pasting the link into the chat joins the room (the plugin's prompt
hook recognises it and tells you the seat). Use the skill when that did not happen.

Run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --join <link>
```

Report the line it prints. Then call `get_room` with the channelId it names, read the brief documents
it lists, and tell the room in ONE line (`post_message` with your `agentId`) which part of the job you
take — nothing longer.

## What this decides

A work room (ADR-046) seats several of the owner's agents in one channel or thread. Joining binds the
SEAT to **this thread**, the same way `/rany-bind` binds a board: room messages addressed to the seat
are queued into this thread and no other. No board has to exist, be bound, or be chosen.

The link is single-use and expires after 24 hours; a used or expired one is refused and the owner makes
a new one. Closing the thread drops the binding — the seat stays in the room, shown as "session
closed", and taking it back needs a new link.
