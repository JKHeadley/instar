# Feedback executor: Claude Code's own empty `.claude/.cc-writes/` folder no longer discards a fix

## What Changed

- `src/feedback-factory/execute/changeSet.ts`: new `claudeDirBreach(workspace)`, used by `buildChangeSet`. A `.claude/` in the session workspace used to fail the attempt as `sandbox-breach` whatever it held. Claude Code 2.1.310 (installed 2026-10-26) creates an empty `.claude/.cc-writes/` directory itself whenever its sandboxed shell runs — reproduced with a bare `claude -p` in a fresh folder — so both of that morning's first real fix attempts were discarded on it. Now `.claude/` passes only when it is a real directory (not a link) that is empty or holds exactly one entry, a real, empty `.cc-writes` directory. A file, a link, any other name (case or Unicode variants included), anything inside `.cc-writes`, or any inspection error other than "does not exist" is still a breach.
- `src/feedback-factory/execute/confinementCanary.ts`: the session canary adds `session-claude-dir-clean`, the same check, so a framework update that starts leaving something under `.claude/` fails the rehearsal once instead of discarding every real attempt. `CANARY_VERSION` → `feedback-canary-v3` (a probe changed; the versioned latch makes the next tick run the new canary).

## What to Tell Your User

The feedback pipeline's first two real fixes were thrown away because the newest Claude Code leaves an empty housekeeping folder in the sealed workspace, which the final check mistook for an escape. That one exact empty folder is now accepted; anything else there is still refused, and the pre-check now tests the same rule.

## Summary of New Capabilities

None — internal fix.

## Evidence

Live: 2026-10-26 05:59 PDT canary ok:true on 1.3.1443 (Claude Code 2.1.310); both attempts then ended `sandbox-breach` at 06:18; their transcripts show no tool call touching `.claude/`; a bare `claude -p --settings <sandbox enabled> … "run: echo hi > out.txt"` in a fresh git folder leaves `.claude/.cc-writes/` (empty, mode 0700). Plain `claude -p` without the sandbox and an interactive session with the confined flags but no sandbox leave nothing. Unit: `execute-units.test.ts` pins absent / empty `.claude/` / empty `.cc-writes` pass; a file inside `.cc-writes`, a settings file beside it, any other empty directory, `.cc-writes` as a file or a link, `.claude` as a link to a clean-looking tree, and `.claude` as a file all fail; the canary probe passes on the bookkeeping shape and fails on a settings file. Independent Codex review: round 1 BLOCKED (inspection errors read as absent), fixed, round 2 CLEAN. 147/147 in the three executor test files; e2e lifecycle 2/2; lint and `tsc` clean.
