# An old server's shutdown can no longer erase its successor from the registry

All agents on a machine share one phone book: `~/.instar/registry.json`. Every server writes itself in at startup and crosses itself out at shutdown. The bug: shutdown crossed out the entry **by address** (the agent's directory path), not by **who wrote it**. During back-to-back update restarts, the new server writes its fresh entry, and then the *old* server's late shutdown fires — and crosses out the new entry, because the address matches. The agent vanishes from the phone book even though its server is alive and healthy.

The vanished entry then stays vanished, because the once-a-minute heartbeat used "find my entry and bump its timestamp" with a silent shrug when the entry was missing. Nothing ever put the entry back. Live trace: echo's log showed "Registered agent" twice in eight minutes (two restart generations), and minutes later the registry had no echo entry at all — which is why `instar worktree create` started refusing the agent home with "agent echo is not present in the instar registry".

The fix is two halves of the same idea — only the owner may erase, and the owner can rewrite:

1. **Pid-guarded unregister.** Server and lifeline shutdown now pass their own process id, and the registry only removes the entry if the recorded pid matches. An old generation's late shutdown sees the successor's pid in the entry, logs that it skipped, and leaves it alone. Operator/CLI removal (instar nuke) keeps the unconditional behavior — a human cleaning up should always win.

2. **Self-resurrecting heartbeat.** The heartbeat now reports whether it found the entry. When the entry is missing and the caller owns a live server, a re-register callback recreates it on the spot (logged loudly, including on the immediate first beat). So even if some *other* writer erases the entry in the future, the agent reappears within one heartbeat interval instead of being durably gone.

Both the server's own registration and the lifeline's `-lifeline` entry get the same treatment, because the lifeline restarts on version skew and drift-promote — the identical race shape.
