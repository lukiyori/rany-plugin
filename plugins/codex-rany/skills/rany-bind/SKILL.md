---
name: rany-bind
description: Claim a RANY task board's work for the repository this session is open in.
---

# Bind a task board to this repository

Argument: `<boardId>`, copied from RANY — the board header has an ID button next to the board
switcher. **With no argument** it instead lists the boards that have had work assigned but are bound
to nothing, so you can see what is waiting.

Run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --bind <boardId>
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --bind            # list unrouted boards
```

Report the line it prints, and nothing more — no summary, no next steps.

## What this decides

The bridge is one daemon for the whole machine, and it can see every open Codex session at once. A
task belongs to one repository, and nothing in the task says which — so without a binding there is
no honest way to pick a session: writing to whichever one happened to be busiest interrupts one
piece of work with another project's.

The unit is the **board**, not the server. A RANY server is a company or a community and holds many
projects; a board is the closest thing RANY has to one. (While a server has only its default board
the two coincide — which is exactly the case that would make binding the server look correct, right
up until someone adds a second board.)

A **server id is accepted too**, but only for *conversations*: someone writing to your persona in a
channel names a server, never a board, so a board binding cannot decide whose that message is.

**A server binding never routes tasks.** RANY gives a server's DEFAULT board the server's own id, so
binding that board and binding the server are the same keystrokes — if the server id also claimed
tasks, adding a second board later would silently send its work to whoever bound the first one.

Binding a board that is already bound elsewhere moves it — the last `/rany-bind` wins, deliberately,
so a moved checkout needs no file edited by hand. The bindings file is shared with the Claude Code
plugin (`~/.rany-plugin/bindings.json`): a board belongs to a repository, not to whichever agent you
happen to be running that day.

**An unbound board wakes nobody.** The sighting is recorded instead, and `--bind` with no argument
prints it. Silence here is not forgetting.

## Where the message actually lands

Binding also tells RANY that this checkout is handling those boards (ADR-033), which is what makes
your persona offered as an assignee on that board at all. The claim is kept alive while a session is
open here and drops when it closes.

When work arrives, the daemon finds the most recently used Codex thread whose working directory is
this repository and queues the notice into it. A live session picks it up within a second; a closed
one keeps it until that thread is next resumed — nothing is dropped.
