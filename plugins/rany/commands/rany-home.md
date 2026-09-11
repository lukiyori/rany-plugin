---
name: rany-home
description: Make THIS session your RANY persona's home — the one place its conversations (mentions, forwards, workflow steps) wake.
---

# Make this session the persona's home

Usually there is nothing to run: typing `/rany-home` already did it (the plugin's prompt hook sets the
home before you read this, and your context says "this session is now your persona's home"). Report
that line and stop.

Only if the context says nothing about it, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/listen.mjs" --home
```

and report the line it prints.

## What this decides (ADR-047)

The persona is one identity with one home, and the owner picks it. Being addressed in a channel
(`@persona`), forwards, workflow steps and questions no board claims wake **this session and no
other** — there is no "whichever window you typed in last" any more. Board work (tasks bound with
`/rany-bind`) and work-room seats (`/rany-join`) are unaffected: they still go to the session that
bound them.

While this session is closed, RANY's hosted AI answers the persona's conversations if a model key is
stored in persona settings; without a key they go unanswered. Run `/rany-home` in another session to
move the home; clear it in RANY → persona settings.
