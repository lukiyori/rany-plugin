---
name: rany-resume
description: List the local conversations this repository's RANY seats were worked in, with the command that continues each one.
---

# Come back to a conversation

No argument. Prints every local session this repository's seats were worked in — Claude sessions and
Codex threads alike — newest first, with the exact command that continues each one, then the other
Claude conversations of this directory.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --resume
```

Show the owner the list as it comes out, and say in one line that the command goes in a NEW terminal:
**this** session cannot become another one. Launch nothing yourself.

## What this decides

Taking a seat back (`/rany-rejoin`, or the automatic re-attach at session start) returns the SEAT — the
room, the name, the identity, the history RANY keeps. It does not return the local conversation: a
binding dies with its window and used to take the session id with it, so the thinking that went with
the work was on disk and unreachable, and the owner kept `claude --resume <guid>` in .bat files by
hand. The seat record now keeps the last few session ids of each seat (`~/.rany-plugin/seat-history.json`),
which is what this lists.

Two other places use the same record. With the `rany-term` shims installed (`/rany-term`), plain `claude`
or `codex` in a seat's directory already continues its last conversation — `claude --new` starts a blank
one, `{"seats":{"autoResume":false}}` in `~/.rany-plugin/rany.json` turns it off. And the runtime reports
the id to the room, so the seat's tile shows its owner the same command.

A session id is local to the machine that ran it: it is reported to RANY only to be shown back to the
seat's own owner, never to anyone else, and a conversation started on another machine cannot be resumed
from this one.
