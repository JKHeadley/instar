# Feedback executor: the sandbox no longer denies the attempt's own temp directory

## What Changed

- `src/feedback-factory/execute/executePolicy.ts`: `systemTempDenies(workspace, attemptTmpDir?)` now drops a shared system temp directory from the deny list when it is an ancestor of the workspace **or** of the attempt's own temp directory, compared by REAL path (`/tmp` is a symlink to `/private/tmp` on macOS, so a textual `startsWith` against the unresolved spelling missed it). Both callsites in `buildSandboxRuntimeSettings` (`denyRead` and `denyWrite`) pass `p.tmpDir`.

Why: `shortAttemptTmpDir` deliberately places each attempt's temp directory under the real `/tmp` because unix socket paths must stay short, and the sandbox runtime documents that for WRITES `denyWrite` takes precedence over `allowWrite` (the reverse of reads, where `allowRead` wins). So `denyWrite: ['/tmp','/private/tmp',…]` overrode `allowWrite: [...,'/private/tmp/fb-<id>']` and the attempt could not create a directory inside its own temp: `EPERM: operation not permitted, mkdir '/private/tmp/fb-8ac70c2cde/HH0KfR7JCSG9zBDVFZQSa'`, thrown by vitest's config resolution. That is the `base-unit-smoke` probe failure that latched the feedback executor for three days (2026-10-22 → 2026-10-25, five consecutive 24h latches). `base-lint-gate` passed the whole time because `npm run lint` never creates a directory under `TMPDIR`; vitest does. The rule already exempted an ancestor of the workspace — a case that never fires in production — and not the attempt temp, which always does.

Found by reading the probe's own captured stderr, which exists because of `b84149fce` hours earlier; before that the entire record was `exit 1`. Two prior hypotheses were wrong: the npm cache redirect (kept, harmless, matches the adjacent precedent) and the host test-runner semaphore — the captured output shows that EPERM explicitly followed by `— admitting the run (fail-open)`.

## What to Tell Your User

The safety rehearsal that runs before the pipeline writes a fix was refusing the pipeline's own scratch folder, so the test step inside it died instantly. That is fixed, and the stop it caused can now be cleared without waiting out a day.

## Summary of New Capabilities

None — internal fix, no new surface. `systemTempDenies` gains an optional second parameter; the one-argument form is unchanged.

## Evidence

`execute-units.test.ts`: a system temp that is an ancestor of the attempt temp is dropped from the deny list (by real path, both the resolved and unresolved spellings); the other shared temps are still denied; with no attempt temp under it the system temp stays denied; and at the settings level no `denyWrite` entry is an ancestor of `p.tmpDir` while `allowWrite` still contains neither `/tmp` nor its real path. Mutation-verified both directions: reverting the exemption fails, and exempting every system temp whenever a tmpDir is passed also fails. 46 files / 643 tests green in `tests/unit/feedback-factory/`; lint and typecheck clean.

Honest residue, stated in the side-effects artifact: `denyRead` also stops carrying the ancestor. For writes the safety rests on allowlist semantics plus the canary's `bash-write-system-temp` must-fail probe, which proves it every run. For reads there is no equivalent per-run probe, so that arm rests on reasoning.
