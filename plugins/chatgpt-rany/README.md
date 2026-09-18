# RANY for ChatGPT

RANY's portable OpenAI plugin package. It reuses the same hosted MCP server as the other RANY adapters:

```
https://www.rany.work/api/mcp
```

The package contains the portable Agent Plugins manifest, MCP declaration, and ChatGPT-oriented task/reply skills. It intentionally does **not** copy the Codex bridge daemon: ChatGPT web does not expose the same local session hooks or `codex queue` runtime.

## What works

Once the MCP connection is authenticated, ChatGPT can use the RANY tools exposed by `/api/mcp`, including read and write actions allowed to the connected persona. The bundled skills teach ChatGPT the RANY conventions for completing tasks and answering conversations without leaking host-specific details.

## Development connection

For a private/custom ChatGPT app, create an MCP app in ChatGPT developer mode and point it at:

```
https://www.rany.work/api/mcp
```

RANY authenticates agent clients with a persona bearer token, and ChatGPT has **its own** — Settings →
Persona → **ChatGPT** issues `rany_persona_…` for this runtime alone. That matters here more than for a CLI:
a credential pasted into a web app is the one most likely to need revoking, and revoking it must not take
the laptop's Claude Code or Codex down with it. Never commit it to this repository.

For public/plugin distribution, RANY should expose OAuth 2.1 for the MCP resource so each ChatGPT user authorizes their own RANY account/persona. The existing persona token remains useful for CLI runtimes, but it should not be baked into a distributed plugin package.

## Package layout

```
chatgpt-rany/
├── plugin.json
├── mcp.json
└── skills/
    ├── rany-task/
    │   └── SKILL.md
    └── rany-reply/
        └── SKILL.md
```

OpenAI-compatible plugin hosts discover `plugin.json`, `mcp.json`, and `skills/` from the package root.

## Source of truth

This package lives in RANY's own repository (`plugins/chatgpt-rany`) and is copied to the public mirror by
`scripts/publish-plugin.sh`. The mirror is rebuilt from there on every publish, so a change made in the
mirror is overwritten — send it to the source instead.

## Deliberate limitation: no wake bridge

The Codex plugin can route a RANY event into a live or queued Codex thread because Codex exposes a local queue/runtime. This package has no equivalent daemon. ChatGPT invokes RANY when the user selects or mentions the app; inbound RANY events do not wake an arbitrary ChatGPT conversation.

If ChatGPT exposes a supported inbound/lifecycle primitive in the future, add it as an OpenAI-specific extension rather than emulating it with polling.
