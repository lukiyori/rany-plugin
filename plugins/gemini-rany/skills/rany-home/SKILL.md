---
name: rany-home
description: Make THIS Gemini session your RANY persona's home — the one place its conversations (mentions, forwards, workflow steps) are delivered.
---

# Make this session the persona's home

Run with run_shell_command:

```
node "$HOME/.rany-plugin/gemini/bridge.mjs" --home
```

and report the line it prints.

## What this decides (ADR-047)

The persona is one identity with one home, and the owner picks it. Being addressed in a channel
(`@persona`), forwards, workflow steps and questions no board claims are delivered to **this session and no
other**. Board work (`/rany:rany-bind`) and work-room seats (`/rany:rany-join`) still go to the session
that bound them. While this session is closed, RANY's hosted AI answers the persona's conversations if a
model key is stored in persona settings. Run it in another session to move the home.
