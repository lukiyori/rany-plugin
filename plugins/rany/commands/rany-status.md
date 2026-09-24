---
name: rany-status
description: Show the work room this session sits in — and the name it carries there — in Claude Code's status line.
---

# Keep the room visible

A join scrolls away, and a seat then works silently: coming back to the window, there is nothing that
says which room it is in, or as whom. This puts it in the status line, where it stays:

```
⬢ #resimler · Reviewer
```

Turn it on:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs" --install
```

Then open a new session — Claude Code reads the setting at start. Turn it off with `--uninstall`.

Report the line the command prints, and nothing else.

## What this decides

Claude Code has ONE status line: `statusLine.command` in `~/.claude/settings.json`, run on every render
with the session JSON on stdin. Something else may already own it (a theme, another plugin), so
`--install` keeps that command, remembers it as `statusLine.chain` in `~/.rany-plugin/rany.json`, and
renders it BEFORE RANY's segment; `--uninstall` puts it back exactly as it was. Nothing is taken over.

The segment names the room and the seat's own name, read from the binding this session already holds —
no network call, nothing to keep in sync. A window with no seat shows nothing: a seat belongs to the
session that took it, and wearing the seat of the window next door would be a lie.
