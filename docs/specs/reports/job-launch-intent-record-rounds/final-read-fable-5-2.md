**DESIGN**

1. **Day-alternating arms have no mechanism, and one pilot job cannot take a local edit.** `thinkingMode` is a static definition field, and the spec says there is "no switch", so alternating by day means rewriting job definitions daily. `promise-review` is a signed instar-origin job (`src/scaffold/templates/jobs/instar/promise-review.md`). A frontmatter edit fails the lock-file hash check and the job is skipped until acknowledged (`AgentMdJobLoader.ts:599-611`). Its manifest is derived by `InstallBuiltinJobs.ts:286`; I did not confirm whether an update rewrites a local manifest edit. The spec must name what flips the arm and where the value lives for instar-origin jobs. The other two pilots are not in `src`; I did not read their definitions.

2. **Graduation matches on `lane`, but no run row carries it.** `launchLane` exists only on `Session` (`SessionManager.ts:5007`); `recordStart` does not store it. The rerouted versus headless lane can differ per spawn. Since D5 freezes the record shape, either add it now or drop it from the criterion.

**PRECISION**

3. **False caller claim.** `routes.ts:12963` is a comment. `buildHeadlessLaunch` has two callers: `PipeSessionSpawner.ts:421` and `SessionManager.ts:4728`.
4. **Wrong file.** `buildPerSlugManifest` lives in `src/scheduler/buildPerSlugManifest.ts:63`, and `PerSlugManifest` is at `AgentMdJobLoader.ts:163`, not 68-75. `manifestToJobDefinition` must also copy the field and is unlisted.
5. **Line off by one.** `headlessBinaryPath` is at `SessionManager.ts:4650`.
6. **"Claude today" is overstated.** The retainer reads `package.json` first and runs `--version` only as a fallback (`ClaudeBinaryRetainer.ts:186-203`). Its `versionCache` is private; the usable seam is `SessionManager.claudeLaunchVersions` (`:7030`). The version is null on any retainer fallback, including wrapper scripts.
7. **"After the last argv/env change" is wrong.** The tmux env flags are snapshotted at `:4844`. `linkAgentOwnedMemory` (`:4864`) and `applyClaudeConfinement` (`:4881`) run afterwards, and the latter mutates argv. Name the capture point.
8. **Criterion 3 should name the call site.** `recordStart` has four: `:1940` and `:2616` (script runs), `:2920` (triage, before spawn) and `:3157`. Only the last gets `launch`.
9. **Pin row.** The pin is unreachable from jobs: `spawnSession` passes no `effort` to the headless builder (`:4728-4744`), nor does the reroute (`:5225`). For `off`, the basis is not an external constraint, since the env channel could coexist with `--effort`; it is a choice mirrored from `:393`. Still deterministic, so invariant holds.
10. **Other three invariant rows hold.** Enum and clamp check out (`topicProfileValidation.ts:21`, `frameworkSessionLaunch.ts:1023, 1328`). I could not verify "2.0 Rule 30" from source.
11. **1-hour TTL.** State whether an expired entry yields the stale value or `unknown`. Jobs on a 6-hour cadence always start expired on non-Claude engines, so they rely on the patch.
12. **`truncated`.** With one feature, `applied` and `dropped` hold at most one entry between them, so the cap is unreachable today. Say whether the count is per array or combined.
13. **`recordLaunchVersion`.** Sound against `recordCompletion`'s first-writer-wins rule (`JobRunHistory.ts:318`) and the copy-latest updaters (`:345-368`). A restart mid-probe leaves `unknown`, which the criterion already excludes.
14. **Floor script.** Its location and its join to Jev grades are unstated; Jev packs are keyed by `runId` (`JevJobCompletionAudit.ts:112`). Define the verdict when the baseline interquartile range is 0.
15. **`promise-review` volume.** It is gated, so 4 a day is a ceiling.

The other line citations I checked are accurate. The checksum command was declined, so I did not confirm the two spec copies are identical.

VERDICT: NOT CONVERGED