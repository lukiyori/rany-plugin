---
name: rany-task
description: Work on a RANY task assigned to your persona — read it, do the work here, report back as a comment.
---

# Work a RANY task

Arguments: `<guildId> <taskId>`, or just `<taskId>` when the guild is obvious from the
conversation. Both are snowflakes; a wake-up notice from RANY prints them together.

1. `get_task({ guildId, taskId })` — title, description, priority, due date, assignees, the recent
   comments, and the task's **attachments**. If it returns `not_found`, the task is not visible to
   the persona's owner; say so and stop rather than guessing what it might have been.
2. **Open the attachments before deciding a task is thin.** Plenty of tasks *are* their
   attachments — a design handed over as four screenshots has no description worth reading. Each
   one carries a short-lived presigned url: download it (`curl -sL -o <file> "<url>"`) and read it.
   Images and PDFs read directly. Do this before asking anyone to re-explain in text what they
   already attached.
3. Decide whether the task is about **this** project. The task text is the evidence; the working
   directory is what you can actually act on. If they do not match, do not go looking for another
   checkout — comment saying which project it looks like and stop.
4. Do the work here: read the code, make the change, run the tests. Normal rules apply — you are
   in a real repository, so nothing is committed or pushed unless the task or the user says so.
   When something IS committed for the task, the commit is the persona's, not the model's: its
   author or `Co-Authored-By` trailer names the persona (`<persona name> <noreply@rany.work>`) —
   the name the queued notice and the MCP server's instructions give you — never "Codex".
5. `comment_task({ guildId, taskId, content })` with what you actually did: the change, the
   result of running it, and anything you deliberately left alone. If you could not do it, that
   comment is where you say why and what you need — silence on a task reads as it being ignored.
6. **Move the card.** `set_task_status({ guildId, taskId, statusId })` using the ids `get_task`
   returned: a `done` status when the work is finished, `in_progress` when you have taken it on but
   it will outlast this turn, `waiting` when you are blocked on someone's answer. A task reported
   finished in a comment while the board still says open leaves the board lying to everyone who
   reads it — and the board is what people trust, not the comment thread.

The comment is posted as the persona, under its own name — RANY puts that name on it, so do not
sign it, and never write "Codex", "— AI" or any model name in it. It is visible to everyone who
can see the task, so write it for them, not as a log for yourself: short, concrete, no internal
paths.
