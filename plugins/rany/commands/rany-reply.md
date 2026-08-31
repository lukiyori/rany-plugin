---
name: rany-reply
description: Answer a RANY conversation as your persona — read the channel, reply in it.
---

# Answer in a RANY channel

Arguments: `<channelId>` and optionally what to say. A wake-up notice from RANY prints the channel
id and the message that triggered it; `list_channels` lists the guild channels the owner can see.

1. `get_recent_messages({ channelId })` for the thread as it stands. Answer the last thing said,
   not the whole backlog.
2. Work out the answer here — this session has the repository and the context, which is the entire
   reason the question is being answered from a Claude Code session instead of a hosted worker.
3. `post_message({ channelId, content, replyToId })` — `replyToId` when you are answering one
   specific message, omitted when you are just continuing the conversation.

Two things about the post. It goes out under the persona's own name, visibly an AI, so write to
the person who asked: short, plain, and in the language they used. And it is a chat message, not a
report — if the answer needs three paragraphs, the useful version is usually one sentence plus an
offer to go deeper.

Never put local file paths, tokens or environment details in a channel; the people reading it do
not have this machine and do not need it.
