---
name: rany-resume
description: List the local conversations this repository's RANY seats were worked in, with the command that continues each one.
---

# Come back to a conversation

No argument. Prints every local session this repository's seats were worked in — Codex threads and
Claude sessions alike — newest first, with the exact command that continues each one.

Run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --resume
```

Show the owner the list as it comes out, and say in one line that the command goes in a NEW terminal:
**this** thread cannot become another one. Launch nothing yourself.

## What this decides

Taking a seat back (`$rany-rejoin`, or the automatic re-attach) returns the SEAT — the room, the name,
the identity, the history RANY keeps. It does not return the local conversation: a binding dies with
its thread and used to take the thread id with it, so the thinking that went with the work was on disk
and unreachable. The seat record now keeps the last few thread ids of each seat
(`~/.rany-plugin/seat-history.json`), which is what this lists.

A thread id is local to the machine that ran it. Nothing here is sent to RANY, and a conversation
started on another machine cannot be resumed from this one.
