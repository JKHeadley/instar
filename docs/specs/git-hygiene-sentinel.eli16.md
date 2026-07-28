# ELI16: Git Hygiene Sentinel

Instar stores many things under `.instar/`. Some are real shared state, like
jobs or registries. Some are local working files, like session logs, inbound
Telegram message files, reports, shadow installs, and private config. Those
local files should stay on the machine that made them.

The bug is that GitSync used a broad staging command for `.instar/`. If a local
runtime file was already tracked, `.gitignore` alone was not enough. Git would
keep seeing the tracked file as changed, and the next sync could commit it
again.

This fix makes GitSync look at the actual dirty paths before staging. For each
dirty path, it asks the file classifier whether the path is safe to sync. Normal
state can still be committed. Runtime directories and secret-bearing config are
skipped. Deletions are still allowed, because agents need to be able to remove
bad tracked files from history going forward.

There is one important parsing detail. Git's machine-readable status format uses
leading spaces as meaningful status characters. The existing helper trims output,
which would corrupt that format. The fix uses a raw helper for this one status
call so the parser sees exactly what Git printed.

The result is that cleaning one checkout is no longer a one-off repair. The
product now has a guardrail that keeps future agent-local state from being
staged by broad GitSync commits.
