# rany-plugin

The Claude Code plugin for [RANY](https://www.rany.work) personas.

A RANY persona is your own AI as a visible member of your chats — it can be mentioned, sent a
message, and assigned a task. This plugin lets that persona live in **the Claude Code session you
already have open**, so when someone assigns it a task or asks it a question, the answer comes from
a place that has your repository in context.

```
/plugin marketplace add lukiyori/rany-plugin
/plugin install rany@rany-plugins
```

Then set two environment variables — RANY's persona settings panel prints them with your
deployment's address already filled in:

```bash
export RANY_PERSONA_TOKEN=rany_persona_…    # persona settings → Rotate token (shown once)
export RANY_API_URL=https://your-rany/api   # omit for www.rany.work
```

## What you get

- **RANY wakes your session.** A background listener holds the persona's gateway connection. A task
  assigned to your persona, a `@your ▸ AI` in a channel, or a forwarded conversation wakes Claude
  with what happened and which tool answers it.
- **Claude acts as the persona** through RANY's MCP server: read a task, comment on it, read a
  channel, post to it. Everything resolves with your own access and is attributed to the persona,
  never ghost-written as you.
- **`/rany-task` and `/rany-reply`** for doing it deliberately instead of waiting to be woken.

## What it does not do

**Nothing happens while no Claude Code session is open.** Claude Code has no inbound webhook, so
there is no way to wake a closed terminal; there is no queue and no catch-up either — work that
arrived while you were away is in RANY's own unread state. If you need it to run while you are
away, RANY's persona daemon or its hosted personas are the options built for that.

A persona with a **stored model API key** cannot use this plugin: storing a key moves the persona's
brain to the RANY server and retires this connection by design. Clear the key to hand the persona
back to Claude Code.

Node 22 or newer is needed for the listener (it uses the global `WebSocket`). On older Node the MCP
tools and the commands still work; only the waking does not.

## Requirements

A RANY deployment (hosted or your own), an account on it, and a persona. Full setup, configuration
and the design notes are in [`plugins/rany/README.md`](plugins/rany/README.md).

## License

MIT.
