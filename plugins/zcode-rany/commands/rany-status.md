---
description: Show what RANY sees from this ZCode session — token, daemon, seats and what is waiting
---

Run the RANY bridge's status with your shell tool and show its output as it is:

```
node "<the RANY bridge path printed at session start>" --status
```

The path is also in `~/.rany-plugin/zcode-bridge-path.txt`. If it says the token is missing, the
session reaches nothing: issue a ZCode token in RANY → persona settings → ZCode and put it in
`~/.rany-plugin/zcode.json` as `{"token":"rany_persona_…"}`.

Then say in one line what is working and what is not — do not explain the parts that are fine.
