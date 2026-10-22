## What Changed

- **The green-PR watcher can now recognise its own leftover merge process on macOS.** After a crash or restart, the watcher looks for a `safe-merge` process left over from the interrupted attempt and kills its process group only once it has proven the process is its own (a per-attempt token). That proof read `/proc/<pid>/environ`, which macOS does not have, so on a Mac a leftover was never confirmed and never killed. The token now also rides the command line (`--attempt-token <hex>`, a new identity-only safe-merge flag, advertised as the `attempt-token` capability and passed only when the probed script advertises it), and the watcher reads it with `ps -o args=`; `/proc` environ stays as a Linux fallback.
- **An unconfirmed live leftover is kept, not forgotten.** Before, the watcher deleted its in-flight record even when the recorded process was still alive and unconfirmed, losing its only handle on it and letting a new merge attempt start beside the old one. Now that record is kept (marked `reapIncompleteAt`, audited `orphan-reap-incomplete`), and every new attempt is refused with `skipped:orphan-unresolved` while the recorded pid is alive. Once the pid is gone, the PR's state is re-checked and the record cleared, and merging resumes on its own. The refusal does not count against the PR's retry ladder or the breaker, and raises one attention line (posted once; removed, with the aggregate re-posted, when attempts resume or a warm-up reap succeeds). A reused pid does not block forever: the record stores the attempt's deadline, and once the attempt's deadline + kill grace + 5 minutes have passed, the record is cleared without a kill (audited `orphan-presumed-foreign`) when the process's command line reads successfully and shows no safe-merge. If it cannot be read, or it is a safe-merge we cannot prove is ours (a hung one can outlive its deadline), the record is kept. Identity also requires the pinned safe-merge path on the command line. Any surviving record is now resolved at the start of every attempt, so a confirmed live leftover is killed there too, not only at warm-up.

## What to Tell Your User

Nothing to do. On a Mac, if a merge attempt was interrupted by a restart, I can now tell whether the leftover process is mine and clean it up. If I can't tell, I leave it alone and pause auto-merging until it exits, rather than starting a second merge next to it; you'd see one "auto-merge is paused" note in that case.

## Summary of New Capabilities

- safe-merge accepts `--attempt-token <hex>` (identity only) and advertises `attempt-token` in `--capabilities`.
- New MergeRunner outcome `skipped:orphan-unresolved`; `reapOrphan()` can return `{ reaped: false, outcome: 'orphan-reap-incomplete' }`.

## Evidence

- `tests/unit/merge-runner.test.ts`: argv identity confirmed → group killed and cleared; `/proc` environ fallback; a different token is not a match; unconfirmed + alive → nothing killed, record kept, `run()` refuses; unconfirmed + pid gone → re-verified, cleared, attempt proceeds; flag passed only when advertised; a real child process identified through the real `ps` read on macOS.
- `tests/unit/green-pr-automerger.test.ts`: the skip never advances the ladder or breaker, the attention line posts once over three ticks and is dropped when attempts resume; a kept warm-up reap is audited `orphan-reap-incomplete`.
- `tests/unit/safe-merge-hardening.test.ts`: `--attempt-token` accepted, validated, advertised.
