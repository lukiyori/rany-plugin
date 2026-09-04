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
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --bind <boardId>
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --bind            # list unrouted boards
```

Report the line it prints, and nothing more — no summary, no next steps.

## What this decides

The plugin is installed per user, so it is live in **every** Claude Code session on this machine. A
task belongs to one repository, and nothing in the task says which. Without a binding a task
assignment cannot be routed: waking whichever session happened to start first interrupts unrelated
work with somebody else's project.

**A bind belongs to THIS session, not just this directory (ADR-038).** Open two terminals in the
same repository — a long autonomous run and the one you are typing in — and only the window that ran
`/rany-bind` wakes for that board. Closing that window drops the bind (and stops offering the persona
as an assignee for it); re-run `/rany-bind` in another session to move the work there. A binding made
by an older plugin that predates this is directory-scoped and still works, but only the active window
answers it — re-bind to make it precise.

The unit is the **board**, not the server. A RANY server is a company or a community and holds many
projects; a board is the closest thing RANY has to one. (While a server has only its default board
the two coincide — which is exactly the case that would make binding the server look correct, right
up until someone adds a second board.)

A **server id is accepted too**, but only for *conversations*: someone writing to your persona in a
channel names a server, never a board, so a board binding cannot decide whose that message is.

**A server binding never routes tasks.** Note that RANY gives a server's DEFAULT board the server's
own id, so binding that board and binding the server are the same keystrokes — if the server id also
claimed tasks, then adding a second board later would silently send its work to whoever bound the
first one. A board that has not been bound wakes nobody, however its server is bound.

Binding a board that is already bound elsewhere moves it — the last `/rany-bind` wins, deliberately,
so a moved checkout (or a moved window) needs no file edited by hand.

**An unbound board wakes nobody.** Not "everybody once" — announcing it in every open session
interrupts N unrelated pieces of work to solve a discovery problem, and solves it in the worst
place: a session that by definition cannot tell whether the task is its own. The sighting is
recorded instead, and `--bind` with no argument prints it. Silence here is not forgetting.
