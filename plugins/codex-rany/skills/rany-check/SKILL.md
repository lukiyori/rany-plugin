---
name: rany-check
description: Say whether RANY can actually reach this Codex session — token, daemon, gateway connection, the seats bound to this folder and the last event that arrived.
---

# Can RANY reach this session?

Run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --status
```

Report the lines it prints, then say in ONE sentence which of them is the problem, if any. Do not
guess beyond what they say — every line is read off disk, so a line that says `UNKNOWN` means exactly
that.

## What this answers

"The bridge is running" proves nothing: the daemon retries its gateway socket forever, and before
0.38.0 it did so silently — a bridge that had never connected and an idle, healthy one looked the
same from outside. This separates them:

- **token** missing → nothing can reach this machine at all; set `RANY_PERSONA_TOKEN` and start a new
  terminal (an already-open Codex never sees a variable set after it started).
- **daemon** not running → any Codex session start brings it back; `--daemon` runs it in the foreground.
- **daemon** on another version → an update landed but the old process still holds the socket; the next
  session start now replaces it (before 0.38.0 it did not, and a daemon from a deleted plugin folder
  kept running for days).
- **gateway** NOT CONNECTED → the socket is the fault, not the plugin. `~/.rany-plugin/routing.log` has
  the close reason on a `DAEMON` line. A refused token says so in full.
- **events** none since the daemon started, while the gateway is connected → RANY is not sending
  anything here: usually no seat is bound to this folder (see the `seats` line) or the room is paused.
- **seats** none → paste the room's invite link, or `$rany-rejoin` to take a remembered seat back.

Nothing here contacts the network, so it works while the network is what is broken.
