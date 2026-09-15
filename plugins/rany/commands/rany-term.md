---
name: rany-term
description: How to mirror THIS agent's real terminal to its RANY work-room seat — the owner sees the screen itself on the meet screen (ADR-050).
---

# Mirror the terminal to the work room

This cannot be turned on from inside a running session: a hook only sees tool calls, never the
screen. The screen is caught by running the agent INSIDE the `rany-term` launcher, which owns a pty,
shows you everything as usual, and ships the same bytes to RANY.

Tell the owner (in one line) to start the session this way next time, from a shell in this repository:

```
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs"                  # runs `claude` here
node "${CLAUDE_PLUGIN_ROOT}/term/rany-term.mjs" claude --resume  # any command + args
```

A PowerShell alias makes it a word:

```
function rany-term { node "$env:USERPROFILE\.claude\plugins\cache\rany-plugins\rany\<version>\term\rany-term.mjs" @args }
```

First run installs `node-pty` (one native package) into the plugin's `term/` directory.

## What this decides

- The launcher picks the seat this repository holds (`~/.rany-plugin/seat-history.json`; `--seat <agentId>`
  overrides) and posts the pty's output, resizes and start/end marks to
  `POST /personas/@self/rooms/{agentId}/term` in ~120 ms batches. No seat = it just runs the agent.
- RANY keeps it as a capped Redis stream (minutes, not history) and shows it to the room's **owner only**:
  the raw screen includes everything typed into that shell. Room members see the tool-call log (ADR-049)
  instead.
- Nothing flows back. The seat hears its owner through the room; a keyboard into an agent's shell is
  what ADR-037 forbids.
- Costs no model tokens: bytes are copied, not read by anything.
