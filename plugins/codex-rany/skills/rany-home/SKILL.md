---
name: rany-home
description: Make THIS Codex thread your RANY persona's home — the one place its conversations (mentions, forwards, workflow steps) are queued.
---

# Make this thread the persona's home

Usually there is nothing to run: typing `$rany-home` already did it (the plugin's prompt hook sets the
home before you read this, and your context says "this thread is now your persona's home"). Report
that line and stop.

Only if the context says nothing about it, run:

```
node "${PLUGIN_ROOT}/scripts/bridge.mjs" --home
```

and report the line it prints.

## What this decides (ADR-047)

The persona is one identity with one home, and the owner picks it. Being addressed in a channel
(`@persona`), forwards, workflow steps and questions no board claims are queued into **this thread and
no other**. Board work (tasks bound with `rany-bind`) and work-room seats (`rany-join`) are unaffected:
they still go to the thread that bound them.

While this thread is closed, RANY's hosted AI answers the persona's conversations if a model key is
stored in persona settings; without a key they go unanswered. Run `$rany-home` in another thread to
move the home; clear it in RANY → persona settings.
