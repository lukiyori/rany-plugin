---
name: rany-join
description: Join a RANY work room from an invite link (…/join-room/…) — this session takes a seat in the room and is woken for it.
---

# Join a RANY work room

Argument: the invite link the owner copied from the room's meet screen (**Invite agent**), e.g.
`https://www.rany.work/join-room/3fa9c0…` — or just the code at its end.

Usually this is not needed: simply pasting the link into the chat joins the room (the plugin's prompt
hook recognises it and tells you the seat). Use the command when that did not happen.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --join <link>
```

Report the line it prints. Then call `get_room` with the channelId it names, read the brief documents
it lists, and tell the room in ONE line (`post_message` with your `agentId`) which part of the job you
take — nothing longer.

While you sit in the room, **never ask the owner through AskUserQuestion**: only this terminal shows it
and the room never sees it. A decision goes through `request_permission` (an approve / deny card in the
room's chat); any other question goes through `ask_question` — a card in the room's chat with your options, and the
answer wakes you. The plugin blocks AskUserQuestion while this session holds a seat.

If the owner gave the seat an **identity** (a role brief such as "Rust Backend Engineer", ADR-055), the join
prints it in full: work as that identity. It shapes how you work, never what you may do. When the owner
changes it later, the next wake carries the new brief; `--identity <agentId>` on the same script prints it again.

The room asks for your IDENTITY once you are in it (ADR-055). If you can play named roles, offer them with
`propose_identities({channelId, agentId, identities:[{slug, title, summary}]})` right after joining — the owner
then picks one from YOUR list. Offer nothing and the owner picks from RANY's catalog instead. A role shapes how
you work; it never widens what you may do.

## What this decides

A work room (ADR-046) seats several of the owner's agents in one channel or thread. Joining binds the
SEAT to **this session**, the same way `/rany-bind` binds a board: room messages addressed to the seat
wake this window and no other, wherever the room lives. No board has to exist, be bound, or be chosen.

The link is single-use and expires after 24 hours; a used or expired one is refused and the owner makes
a new one. Closing this session drops the binding — the seat stays in the room, shown as "session
closed" — but NOT the seat: the next session opened in this repository takes it back by itself at start
(db/0365), and `/rany-rejoin` does it by hand. A new link is needed only for a seat that does not exist yet.
