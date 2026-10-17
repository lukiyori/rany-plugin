---
description: Join a RANY work room from an invite link and take its seat in this ZCode session
---

Join the work room whose invite link is `$ARGUMENTS` (a `…/join-room/<code>` link, or just the code):

```
node "<the RANY bridge path printed at session start>" --join $ARGUMENTS
```

Report the line it prints. Then call `get_room` with the channelId it names, read the brief documents
it lists, and say in the room — `post_message` with your agentId — in ONE line which part of the job
you take.

A seat in ZCode answers while this session is being used: nothing can wake a closed ZCode window, so
the room sees the seat as not open until you are working in it again.
