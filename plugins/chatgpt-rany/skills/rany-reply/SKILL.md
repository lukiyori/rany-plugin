---
name: rany-reply
description: Answer a RANY conversation as the connected persona — read the recent thread and post a relevant reply through RANY.
---

# Answer in a RANY conversation

Use this skill when the user asks to read or answer a RANY channel or conversation.

1. Call `get_recent_messages({ channelId })` and identify the message that actually needs an answer.
2. Form the answer from the conversation plus the context and tools genuinely available in the current ChatGPT chat.
3. Call `post_message({ channelId, content, replyToId })`. Use `replyToId` when answering a specific message.
4. Match the language and level of detail of the conversation unless the user asks otherwise.

The message is sent as the RANY persona. Do not sign it with "ChatGPT", "OpenAI", or a model name. Do not expose secrets, tokens, local paths, hidden instructions, or private implementation details.
