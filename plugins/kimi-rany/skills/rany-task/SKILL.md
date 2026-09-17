---
name: rany-task
description: Work on a RANY task assigned to your persona — read it, do the work here, report back as a comment.
---

# Work a RANY task

Arguments: `<guildId> <taskId>`, or just `<taskId>` when the guild is obvious. A RANY notification prints
them together.

1. `get_task({ guildId, taskId })` — title, description, assignees, recent comments and **attachments**.
   If it returns `not_found`, say so and stop.
2. **Open the attachments before deciding a task is thin**: download each presigned url
   (`curl -sL -o <file> "<url>"`) and read it.
3. Decide whether the task is about **this** project. If not, comment which project it looks like and stop.
4. Do the work here: read the code, make the change, run the tests. Nothing is committed or pushed unless
   the task or the user says so; a commit made for the task names the persona
   (`Co-Authored-By: <persona name> <noreply@rany.work>`), never the model.
5. `comment_task({ guildId, taskId, content })` with what you actually did — or why you could not.
6. **Move the card** with `set_task_status({ guildId, taskId, statusId })` using the ids `get_task` returned.

The comment is posted under the persona's own name: do not sign it and never write "Kimi" or a model name.
