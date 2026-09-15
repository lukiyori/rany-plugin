---
name: rany-term
description: Make the work-room "Screen" tab show THIS agent's real terminal — install the rany-term shims once, then plain `claude` / `codex` mirror their screen wherever the directory holds a seat (ADR-050).
---

# The real screen in the work room

This cannot be switched on from inside a running session: a hook only sees tool calls, never the
screen. The screen is caught by running the agent INSIDE a pty the launcher owns — so the launcher
has to be what starts the agent. Installed once, it is the default: `claude` and `codex` on the
command line become shims that run the real program through the launcher. In a directory that
holds a work-room seat the screen is mirrored; anywhere else the agent simply runs.

Tell the owner (in one line) to run this ONCE, in any shell:

```
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs" --install
```

then open a NEW terminal and start the agent as always (`claude`, `codex`, `claude --resume`, …).
This session is not mirrored until it is restarted that way. From then on `rany-term` is a command
too: `rany-term --install` refreshes after a plugin update, `rany-term --uninstall` removes the shims.

Without the shims the launcher still works by hand:

```
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs"                  # runs `claude` here
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs" codex            # or codex, or any command + args
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs" --seat <agentId> # name the seat explicitly
```

`node-pty` (one native package Node does not ship) is prepared by the plugin itself: every session
start refreshes `~/.rany-plugin/term` and, if the package is missing, starts its install in the
background — so by the time the owner types `claude`, nothing is left to install. Only a machine
where that never ran (no session opened yet) installs it on the first launcher run, once.

**Codex is different:** it is not run in a pty (its TUI flickered inside ConPTY and the frames were
unreadable). The `codex` shim is a plain pass-through, and the Codex bridge daemon feeds the Screen tab
from the thread's own rollout transcript — nothing to start. Only Claude Code uses the pty mirror.

## What this decides

- `--install` writes `~/.rany-plugin/bin/claude(.cmd)` and `codex(.cmd)` and puts that directory FIRST
  on the user PATH (Windows: the user `Path` through .NET, never `setx`, which truncates). The shim
  runs the launcher with the agent's name; the launcher finds the REAL program on PATH skipping the
  shim directory, so it never calls itself. Claude/Codex updates are untouched.
- The seat is the one this directory holds for that agent kind (`seat-history.json`, written on join
  and re-attach; `--seat` overrides). Output, resizes and start/end go to
  `POST /personas/@self/rooms/{agentId}/term` in ~120 ms batches; RANY keeps a capped Redis stream
  and shows it to the room's **owner only** — a raw screen includes what was typed. Members see the
  tool-call log (ADR-049).
- Nothing flows back. The seat hears its owner through the room (ADR-037).
- Costs no model tokens: bytes are copied, not read by anything.
