# Side-Effects Review — lint: ban blocking process scans on the runtime hot path

**Version / slug:** `lint-no-blocking-process-scans`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (a new CI lint + comment-only src annotations + a test; no behavior change, no API/route/config/migration)
**Second-pass reviewer:** `Echo (self) — Tier-1; preventive gate, no runtime behavior change`

## Summary of the change

Adds `scripts/lint-no-blocking-process-scans.js` (wired into `npm run lint`): in
`src/monitoring/` and `src/server/`, a SYNCHRONOUS child-process call
(`spawnSync`/`execSync`/`execFileSync`) whose command literal is a process-
enumeration tool (`ps`/`pgrep`/`lsof`/`pkill`) now fails CI. This is post-mortem
standard #3 for the 2026-06-07 "server temporarily down" incident (topic 21816):
synchronous `ps`/`lsof` scans on a cadence blocked the event loop and starved
`/health` under load → the supervisor restarted an alive server → the loop.
#972 fixed SessionWatchdog; this lint stops the class from being re-introduced.

The two existing in-dir call sites are `lsof` one-shots, allowlisted with inline
`// lint-allow-blocking-scan:` justifications (comment-only edits):
- `SessionRecovery.ts` — targeted `lsof -p <pid>` (single process, 5s timeout),
  runs once during a session's JSONL recovery, not on a cadence.
- `agentWorktreeGit.ts` — full-cwd `lsof` in AgentWorktreeReaper, which ships
  dark + dry-run by default (not on any live agent's hot path); 15s timeout;
  async conversion noted as a follow-up.

## Decision-point inventory

- The only decision: which sync calls to fail CI on. Scoped to the documented
  load-sensitive enumeration commands (`ps`/`pgrep`/`lsof`/`pkill`) in the two
  runtime hot dirs. tmux/git calls are deliberately NOT covered (bounded, fast,
  ubiquitous — converting them is a separate, bigger concern and not this
  incident's cause).

## 1. False positives (flagging a safe call)

A genuinely one-shot, bounded sync scan is excused by an inline
`// lint-allow-blocking-scan: <reason>` (scanned up to 6 lines above the call to
allow a multi-line justification). The escape hatch requires a written reason, so
the decision is reviewed, not silent. Two current sites use it.

## 2. False negatives (missing a real one)

Static detection matches a string-literal command. A sync scan that passes the
command via a variable (e.g. `execFileSync(file, args)` in `mcpProcessReaperDeps`)
is not caught — accepted: the lint is a ratchet against the common, copy-pasted
literal form; the variable-indirection cases are pre-existing and tracked. tmux
is intentionally out of scope.

## 3. Level-of-abstraction fit

Correct: a CI lint in the existing `lint-no-*` family, modeled on
`lint-no-unfunneled-headless-launch.js`. Structure > Willpower — a future periodic
`spawnSync('ps')` fails the build instead of being discovered as a stall in prod.

## 4. Blast radius

CI-only. No runtime code changes (the two src edits are comments). Cannot affect a
running agent. Worst case of a bug in the lint = a spurious CI failure, fixed by an
allowlist comment or a lint tweak — never a production impact.

## 5. Rollback

Remove the script + the one `package.json` chain entry; revert the two comment
annotations. No state/format change.

## 6. Tests

`tests/unit/lint-no-blocking-process-scans.test.ts` (5): flags sync ps; flags
spawnSync pgrep + execSync lsof; honours the inline allow justification; ignores
comment-only mentions + async/tmux calls; the real runtime tree is clean. The lint
also self-validated against a synthetic violation. tsc clean.
