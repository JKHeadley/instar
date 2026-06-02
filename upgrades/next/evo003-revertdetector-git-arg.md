## What Changed

Fixed a long-standing silent no-op in `RevertDetector`, the part of the
failure-learning loop that watches recent git history for `Revert "..."`
commits and opens a forensic record when it finds one. Its `git log` scan
included `--regexp-ignore-case=false` — a flag git does not accept in that
`=value` form. git rejected the whole command (`fatal: unrecognized
argument`), the call threw on every tick, the error was swallowed by the
surrounding try/catch, and the scan returned 0. The result: revert
detection has never actually fired on any install. The fix deletes the
invalid flag (case-sensitive matching is git's `--grep` default, which is
the intended behavior) and adds a NOTE comment so it can't be reintroduced.
Two regression tests pin it: an argv-shape assertion and a real-git
end-to-end test (real temp repo + real revert) that would have caught the
original bug.

## What to Tell Your User

Nothing you need to do. After this update, my revert-detection arm actually
works — if a commit in my recent history is a revert, I now open a forensic
record for it instead of silently missing it. This was a behind-the-scenes
observer that was quietly broken; no user-facing behavior or messages
change.

## Summary of New Capabilities

- RevertDetector's `git log` scan now runs with a valid argv, so revert
  detection works fleet-wide for the first time (previously a silent no-op).
- Regression coverage: an argv-shape test rejects any reappearance of a
  `--(no-)?regexp-ignore-case=` flag, and a real-git end-to-end test proves
  a genuine `git revert` commit opens exactly one forensic FailureLedger
  record.

## Evidence

**Reproduction (the broken command, against any git):**

```
$ git log -n 50 --grep=^Revert --regexp-ignore-case=false --format=%H
fatal: unrecognized argument
$ echo $?
128
```

git 2.39.5 (Apple Git-154) rejects the `=value` form of the case flag — this
is not version-specific; git has never accepted it. In `RevertDetector` the
non-zero exit throws, the try/catch swallows it, and `scanForReverts`
returns 0.

**Before:** revert detection returns 0 on every tick regardless of history.
Confirmed in `echo`'s `logs/server-stderr.log` (the throw was seen 4× during
a learnings harvest). The flag is present on canonical main at
`src/monitoring/RevertDetector.ts:143`.

**After:** with the flag removed, the new real-git regression test creates a
temp repo, commits, runs a real `git revert --no-edit HEAD`, and drives
`RevertDetector` with its default `SafeGitExecutor` runner — `tick()`
returns 1 and exactly one `source: 'revert'` forensic record is opened. The
argv-shape test asserts the scan command carries no `--(no-)?regexp-ignore-case=`
flag. 11/11 unit tests pass; `tsc`, `lint`, and `build` are clean.
