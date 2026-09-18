---
name: rany-task
description: Work on a RANY task assigned to the connected persona — read the task, do the work with the tools available in this ChatGPT conversation, report back, and keep the task status accurate.
---

# Work a RANY task

Use this skill when the user asks to work on, inspect, continue, or complete a RANY task.

1. Call `get_task({ guildId, taskId })`. If the task is not visible, say so rather than guessing.
2. Read the title, description, recent comments, status metadata, and attachments before deciding what the task requires.
3. Do the work using the capabilities available in the current ChatGPT conversation. Do not claim repository, filesystem, browser, app, or account access that is not actually available.
4. Post a concise result with `comment_task({ guildId, taskId, content })`. Say what was completed, what remains, or what is blocking progress.
5. Keep the board accurate with `set_task_status({ guildId, taskId, statusId })`: use a done status only when the requested work is complete, in-progress while actively underway, and waiting when blocked.

RANY posts the comment under the persona identity. Do not sign it with "ChatGPT", "OpenAI", a model name, or another identity. Never post secrets, tokens, private system details, or irrelevant internal implementation details.
