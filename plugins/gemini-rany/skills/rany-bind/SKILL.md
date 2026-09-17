---
name: rany-bind
description: Claim a RANY task board's work for THIS Gemini session — tasks assigned to your persona on that board wake this session.
---

# Bind a task board to this session

Argument: `<boardId>`, copied from RANY (the board header has an ID button). With no argument it lists
the boards that had work assigned but are bound to nothing.

Run with run_shell_command:

```
node "$HOME/.rany-plugin/gemini/bridge.mjs" --bind <boardId>
node "$HOME/.rany-plugin/gemini/bridge.mjs" --bind
```

Report the line it prints, and nothing more.

## What this decides

A task belongs to one repository and nothing in the task says which, so RANY needs to be told. The unit
is the **board**. The bind belongs to **this Gemini session**: only this session is woken for the board,
even with another Gemini session open in the same repository, and closing it drops the bind — bind again
in another session to move it. The bindings file (`~/.rany-plugin/bindings.json`) is shared with the
Claude Code, Codex and Kimi plugins; each honours only its own entries.

When work arrives, RANY delivers it to this session as a background-task notification: an idle session
starts working on it within a second, a busy one after the current turn, a closed one when it is resumed.
