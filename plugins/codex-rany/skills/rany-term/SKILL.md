---
name: rany-term
description: Why the work-room "Screen" tab shows what THIS Codex thread did without anything to start — the bridge daemon streams the thread's own transcript (ADR-050, Codex variant).
---

# The Screen tab for a Codex seat

Nothing to install, nothing to start. Codex writes everything it does to its rollout file
(`~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<threadId>.jsonl`) as it happens; the RANY bridge daemon —
already running for every Codex seat — tails that file and posts each completed item as a terminal
line to the seat's Screen: what the owner wrote (`›`), what Codex answered, every command (`$ …`, with
its output and a non-zero exit code), every file change (`✎`), every MCP tool call (`⚙`). Reasoning is
not shown: the screen is what was done, not what was thought.

Codex is deliberately NOT run inside a pty: its TUI redraws many times a second and flickered inside
ConPTY, and the mirrored frames were unreadable. The transcript is exact and calm.

If the owner asks why the Screen tab is empty for this thread:
- the daemon must be running (`~/.rany-plugin/codex-bridge.pid`; any prompt restarts it);
- this thread must hold a seat (`$rany-join` / `$rany-rejoin`);
- lines appear from the moment the seat was taken — with a little of the recent transcript before it.

The view is the room **owner's** only (a transcript includes what was typed); members see the tool-call
log (ADR-049). Nothing flows back to Codex (ADR-037). No model tokens are spent.
