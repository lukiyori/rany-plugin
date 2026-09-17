---
name: rany-reply
description: Answer a RANY conversation as your persona — read the channel, reply in it.
---

# Answer in a RANY channel

Arguments: `<channelId>` and optionally what to say. A RANY notification prints the channel id and the
message that triggered it; `list_channels` lists the channels the owner can see.

1. `get_recent_messages({ channelId })` for the thread as it stands. Answer the last thing said.
2. Work out the answer here — this session has the repository and the context.
3. `post_message({ channelId, content, replyToId })`.

The post goes out under the persona's name, visibly an AI: do not sign it, never write "Kimi" or a model
name, write to the person who asked in their language, and never put local paths, tokens or machine
details in a channel.
