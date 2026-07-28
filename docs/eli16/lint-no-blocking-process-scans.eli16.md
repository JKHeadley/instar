# Lint: no blocking process scans on the hot path — Plain-English Overview

> One line: the server is single-threaded, so when it runs a slow command like `ps` or `lsof` and waits for it, it can't do anything else — including answer "am I alive?". Under load those commands get slow, the health check times out, and the watchdog restarts a server that was actually fine. This adds a build check that stops anyone from re-introducing that pattern.

## The problem this guards against

A background monitor that runs `ps` / `pgrep` / `lsof` *synchronously* on a timer freezes the whole server for as long as that command takes. On a busy machine `ps`/`lsof` can take seconds. Stack a few of those up and the server can't answer its health check in time — so the watchdog thinks it's dead and restarts it. That was a direct contributor to the 2026-06-07 "server temporarily down" restart loop (root cause #4 in the post-mortem).

## What already happened

PR #972 already converted the worst offender (the SessionWatchdog) to run those scans *asynchronously*, so they yield the event loop instead of freezing it. But nothing stopped the pattern from creeping back into a new monitor. That's what this check is for.

## What this adds

A CI lint: in the runtime directories (`src/monitoring`, `src/server`), a synchronous `ps`/`pgrep`/`lsof`/`pkill` call now fails the build. The fix is to use the async version (`execFileAsync`), which doesn't block the event loop.

## The escape hatch

A genuinely one-shot, bounded call (not on a timer) can opt out with a one-line comment explaining why: `// lint-allow-blocking-scan: <reason>`. It requires a written reason, so the exception is a reviewed decision, not a silent one. Two existing `lsof` calls use this — one is a targeted single-process check during recovery; the other is in a reaper that ships off-by-default.

## What it does NOT cover

It deliberately ignores tmux and git calls (those are fast and bounded — not the load-sensitive enumeration commands this incident was about), and it can't catch a scan whose command is passed through a variable. It's a ratchet against the common, easy-to-copy mistake, not a complete static proof.

## Why a lint and not just a note

Structure > Willpower: a comment in a doc is a wish; a build check is a guarantee. A future periodic `spawnSync('ps')` now fails CI instead of being discovered as a production stall.

## Evidence

`tests/unit/lint-no-blocking-process-scans.test.ts` (5 tests): flags a sync `ps`; flags `spawnSync('pgrep')` and `execSync('lsof …')`; honours the inline allow comment; ignores comment-only mentions and async/tmux calls; the real tree is clean. CI-only change; no runtime behavior change (the two source edits are comments).
