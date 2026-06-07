<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

New CI lint `scripts/lint-no-blocking-process-scans.js` (wired into `npm run lint`):
in `src/monitoring/` and `src/server/`, a synchronous `ps`/`pgrep`/`lsof`/`pkill`
call (`spawnSync`/`execSync`/`execFileSync` with a literal command) now fails the
build. This is post-mortem standard #3 from the 2026-06-07 "server temporarily
down" incident (topic 21816): synchronous process-enumeration scans on a cadence
blocked the event loop and starved `/health` under load, which made the supervisor
restart an alive server → the restart loop. #972 fixed the SessionWatchdog; this
lint stops the class from being re-introduced anywhere in the runtime dirs.

## What to Tell Your User

Internal hardening — nothing user-visible. It makes a specific cause of the
"server temporarily down under load" problem impossible to reintroduce.

## Summary of New Capabilities

- `npm run lint` now fails on a synchronous process scan in the runtime hot dirs.
  Use the async exec (`promisify(execFile)`/`execFileAsync`) instead, or — for a
  genuinely one-shot bounded call — add an inline `// lint-allow-blocking-scan:
  <reason>` (a written, reviewed exception).

## Scope (honest)

CI-only; no runtime behavior change (the two source edits are comment annotations
allowlisting existing bounded `lsof` one-shots). Does not cover tmux/git calls
(bounded, out of scope) or scans whose command is passed via a variable
(pre-existing, tracked). A ratchet, not a complete static proof.

## Evidence

`tests/unit/lint-no-blocking-process-scans.test.ts` (5 tests, all passing); the
lint runs clean on the real tree and flags synthetic violations. tsc clean.
causalAutopsy: incident-derived — direct implementation of post-mortem standard #3
(docs/postmortems/2026-06-07-server-temporarily-down.md, root cause #4); the prior
#972 fix addressed one offender, this prevents recurrence of the class.
