---
name: rany-mail
description: Let your persona send mail from your own mailbox with an app password you already created.
---

# Set up sending mail

Argument: the address the mail should come FROM (`you@gmail.com`). Without one, this lists what is
already set up.

Run it in the terminal yourself — the app password is typed, not pasted into the chat:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/mail.mjs" --setup <address>
```

It asks for the app password, proves it against the mail server before storing anything, and says which
address mail will go out from. Then report the line it printed — nothing else, and never the password.

Other forms: `--list` (which addresses are set up), `--default <address>` (which one sends when none is
named), `--forget <address>` (drop it here; revoke it in the mail account too).

## What this decides

The password is stored **against the address**, in `~/.rany-plugin/mail.json`, owner-only where the OS
honours that. It stays on this computer: it is never sent to RANY, because the `send_email` tool runs
HERE as a local MCP server rather than on the server.

Gmail (and Google Workspace) needs an **app password**, not the account password: turn on 2-Step
Verification, then Google Account → Security → App passwords. Outlook, Yahoo and iCloud work the same
way. Another provider: pass `--host` and `--port` and any SMTP server will do.

Once it is set up, `send_email` takes `to`, `subject`, `body`, and optionally `cc`, `replyTo` and
`from` — `from` picks between several stored addresses; leave it out and the default is used. Gmail puts
a copy in Sent by itself, so nothing here writes one.

Sending mail as the owner is not a thing to do quietly: say who it is going to and what it says, and let
them answer, before the first mail to a new recipient.
