# Measuring the conversation list's history scan (off the request's turn, in slices)

The control measurement for `docs/specs/conversation-list-offthread-scan.md` (pull request 3609). It
must be rerun once when the Studio's test line is idle.

## Rules (binding)

- The real-log copy is **private**: it stays on the machine it came from, in a folder only this user
  can read (`umask 077`), and is **deleted after** the run (the script does this).
- Throwaway servers bind to **localhost only** (port 4195), with messaging, feedback, dispatches,
  updates and the tunnel all off.
- Report **counts only**: timings, row counts, numbers of differences. Never message contents.

## Run

From the PR branch's worktree (with its `node_modules`), on the machine whose agent log is used:

```
docs/specs/reports/conversation-list-offthread-scan-measure/measure.sh "$PWD"
```

- `INSTAR_TELEGRAM_LOG` overrides the log copied (default: this user's Echo agent log).
- `OFFTHREAD_MEASURE_DIR` overrides the private working folder (default `$TMPDIR/pr3609-proof`;
  the name must contain `pr3609-proof`, which `serve.mts` checks before it starts).

It runs three pairs, back to back: a **control** (the same server and log, no requests, 140 s), then
an **Option C cold run** (`run.sh`: cold list, warm list, every chat, scroll-back pages, read marks,
driven by `capture.mts` as a signed throwaway phone). It writes `c7-counts.json` (counts only) and
deletes the copy, keys and run folders.

## The bar

- Every list and chat request finishes in under one second in all three runs
  (`slowestListOrChatMs`, plus the `slowestRequests` list).
- Option C's longest stall is within half a second of its own control (`maxStallMs`).

If it passes, the PR leaves draft and takes a normal place on the Local Verify line. If a stall is
still more than half a second above its control on a quiet machine, the numbers go to the Chief of
Staff.

## Files

- `serve.mts`: the throwaway AgentServer, the event-loop stall recorder (heartbeat gap and histogram,
  stalls over 400 ms with the requests in flight), the slowest requests, peak memory.
- `capture.mts`: the signed device client.
- `keys.mjs`, `meta-from-log.mjs`: the throwaway device key; topic ids and row positions from the
  copy (no text).
