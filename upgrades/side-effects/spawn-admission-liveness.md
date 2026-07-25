# Side-effects review: liveness-aware SpawnAdmission checkpoint

- The dry-run `router-queued-suppress` recorder now consults the local session registry for the same conversation key.
- A live starting/running session remains a would-block; completed, superseded, killed, or absent sessions allow legitimate respawn.
- The checkpoint remains dry-run; no enforcement flip or recovery path is changed.
- Unit coverage proves both classifications, and the PR body records the historical 33368 duplicate versus a legitimate 29723-style respawn.
- Existing harnesses explicitly model a live local session so prior forwarding assertions retain their meaning while the new absent-session path remains covered.
- The server wiring documents that liveness preserves legitimate respawns while keeping live duplicates visible.
