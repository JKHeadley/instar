# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **A failed confinement rehearsal now records what it observed, not just which check failed.** `profileUnenforceable()` wrote only `failed: [probeName]`, and the canary report that explains it (`<tmpDir>/canary-report-<nonce>.json`) is deleted with the attempt tree — so when the executor latched for 24h on `session-git-status`, the cause was unrecoverable and took a full manual sandbox re-run to narrow down. The probe's `detail` now quotes the observed value, distinguishing `<outputs["9"] absent>` (the sandboxed session omitted that entry from its own report) from a genuinely quoted git failure, which the code's `?? 'fatal'` default otherwise renders identical. The latch record gains a bounded, secret-scrubbed `failedDetail`. **The verdict expression is byte-identical and commented as such** — this is recording only, on the failure path, after the decision. All 14 must-fail probes and the latch's 24h semantics are untouched.

## What to Tell Your User

Nothing to do. If the fix pipeline ever stops itself on a sandbox check again, it will say what it saw rather than needing an investigation.

## Summary of New Capabilities

- No new surface. `exec:profile_unenforceable` gains an additive `failedDetail` array (≤300 chars per entry, scrubbed); readers of `failed` are unaffected.

## Evidence

- Live incident: one probe of ~21 failed while every must-fail refusal and every other session probe passed, so the confinement itself held.
- Two hypotheses tested and refuted rather than shipped: the measured macOS `xcrun` cache noise (git exits 0) does **not** match the probe regex and would pass — now pinned by a regression test; and `fatal: not a git repository` cannot apply because the workspace is cloned before the canary runs.
- 45 unit tests pass; three new ones pin the verdict on missing / failing / clean output and assert the detail distinguishes an absent entry from a real failure.
