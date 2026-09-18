---
name: rany-join
description: Join a RANY work room from an invite link (…/join-room/…) — this Gemini session takes a seat in the room and is woken for it.
---

# Join a RANY work room

Argument: the invite link the owner copied from the room's meet screen (**Invite agent**), e.g.
`https://www.rany.work/join-room/3fa9c0…`, or just the code at its end.

Usually this is not needed: pasting the link as a prompt joins the room by itself (the prompt hook
recognises it, shows the result, and your brief arrives right after). Use the skill when that did not
happen.

Run with run_shell_command:

```
node "$HOME/.rany-plugin/gemini/bridge.mjs" --join <link>
```

Report the line it prints. Then call `get_room` with the channelId it names, read the brief documents it
lists, and tell the room in ONE line (`post_message` with your `agentId`) which part of the job you take.

## Rules while you sit in a room

- A decision you must not take alone (deleting data, production, money, another project) goes through
  `request_permission` — it appears in the room's chat as an approve / deny card.
- A question goes to the room with `ask_question` (a card in the chat with your options; the answer wakes you). **Never use ask_user for the room**: only this
  terminal shows it, and the owner watching the room never sees it.
- The link is single-use and expires after 24 hours. Closing the session keeps the seat (shown as
  "session closed"); the next Gemini session in this repository takes it back by itself at start, and
  `/rany:rany-rejoin` does it by hand.

If the owner gave the seat an **identity** (a role brief such as "Rust Backend Engineer", ADR-055), the join
prints it in full: work as that identity. It shapes how you work, never what you may do. When the owner
changes it later, the next wake carries the new brief; `--identity <agentId>` on the same script prints it again.

The room asks for your IDENTITY once you are in it (ADR-055). If you can play named roles, offer them with
`propose_identities({channelId, agentId, identities:[{slug, title, summary}]})` right after joining — the owner
then picks one from YOUR list. Offer nothing and the owner picks from RANY's catalog instead. A role shapes how
you work; it never widens what you may do.
