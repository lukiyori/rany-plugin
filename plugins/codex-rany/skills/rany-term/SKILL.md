---
name: rany-term
description: Make the work-room "Screen" tab show THIS Codex thread's real terminal — install the rany-term shims once, then plain `codex` / `claude` mirror their screen wherever the directory holds a seat (ADR-050).
---

# The real screen in the work room

No hook sees the screen; the bytes are caught only by running the agent inside a pty the launcher
owns. The launcher ships with the Claude Code plugin's files (`plugins/rany/term/rany-term.mjs` in the
same mirror) and is agent-agnostic — it runs `codex` exactly as it runs `claude`.

Tell the owner (in one line) to run this ONCE, in any shell, with the path of that file on this
machine (Claude Code's plugin cache: `~/.claude/plugins/cache/rany-plugins/rany/<version>/term/`):

```
node <path>/rany-term.mjs --install
```

then open a NEW terminal and start Codex as always. `codex` becomes a shim that runs the real
program through the launcher; in a directory that holds a work-room seat the screen is mirrored,
elsewhere Codex simply runs. This thread is not mirrored until it is restarted that way.

## What this decides

- The seat is the one this directory holds for Codex (`~/.rany-plugin/seat-history.json`, written on
  join and re-attach; `--seat <agentId>` overrides).
- RANY keeps the screen as a capped Redis stream and shows it to the room's **owner only** — a raw
  screen includes what was typed. Members see the tool-call log (ADR-049).
- Nothing flows back to the agent (ADR-037). No model tokens are spent: bytes are copied, not read.
