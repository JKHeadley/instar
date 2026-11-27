**DESIGN**

1. **Private job transfer rejects the field.** The Multi-machine posture says the field "travels with them. No new surface." `src/core/JobPortableBundle.ts:13-19` holds a closed `MANIFEST_KEYS` set, and both export (`:52`) and import (`:101`) throw `unknown-manifest-field` on any other key. A portable user job with `thinkingMode` cannot be transferred. §1 must add `MANIFEST_KEYS` (plus a test), or the posture must state the limit.

**PRECISION**

2. **D9 contradicts its own test.** "Appended to `TRUNCATABLE_FIELDS`" means `launch` is shed last of the truncatables (the loop at `JobRunHistory.ts:718` breaks once the row fits). Testing says it "sheds `launch` first". Pick one.
3. **`truncated` does not mark a shed `launch`.** It is set when any field is shed, so a reader cannot tell a shed record from one never written. `recordLaunchVersion` must also no-op when the latest row has no `launch`.
4. **Capture point.** `applyClaudeConfinement` (`:4881`) runs only under `options.confinement`, which `spawnJobSession` never passes. The reroute lane's equivalents (`:5328`, `:5295`, `:5282`) are not named. Say "immediately before the tmux `execFileSync`" for both lanes.
5. **Env snapshot.** Later `-e` flags can override the `:4844` snapshot. `omitAuthEnvFlags` come after it, and I did not check whether the credential pattern matches `MAX_THINKING_TOKENS`. It is off the main job path today.
6. **Codex headless placement.** The `-c model_reasoning_effort` flag must go before `-m <model> <prompt>` (`frameworkSessionLaunch.ts:1094-1096`). The spec doesn't say.
7. **Probe environment.** The retainer's probe sets `CLAUDE_CODE_DISABLE_AUTOUPDATER=1` (`ClaudeBinaryRetainer.ts:217`); `readCliVersion` specifies no env or cwd. Mirror it, use a neutral cwd (grok self-updates), and dedupe in-flight probes per key.
8. **Pin row basis.** "external-constraint" is cited to instar's own interactive builder, which the row itself calls "a chosen policy". The rule is still invariant (a two-input precedence), so relabel it enumerable-domain.
9. **Floor has no dev-rung measurement for "argv/env mismatch".** `jobs.launchIntent` records don't compare argv; only unit tests and test-agent-live do. No script computes the floor in this text; the review job's model reads the counts. Name who counts.
10. **Duplicate entry in §1.** "`manifestToJobDefinition`" and "the projection at `AgentMdJobLoader.ts:1513`" are the same function.
11. **Model coverage.** D8 covers only an Opus job. test-agent-live should add one haiku-tier job with `--effort`, since "sent" is not "accepted".

**Round-3 items**

- Day-alternating arms: gone from the text, correctly cut to the pilot spec.
- 1-hour TTL: coherent with the size/mtime key and the patch path.
- `recordLaunchVersion`: sound against `recordCompletion`'s first-writer-wins, because the patch copies the latest row and preserves `result`.
- Retainer null: the claim is true (`versionCache` at `:326`, `:397-400` has no expiry; fallbacks return `version: null` at `:362`), and the non-null-only rule fixes it.

**Code claims**

Every cited line reference I checked is accurate:
- `JobScheduler.ts`: 1940, 2616, 2920, 3137, 3157
- `JobRunHistory.ts`: 11, 373
- `SessionManager.ts`: 4650, 4728-4744, 4836-4838, 4844, 7030
- `frameworkSessionLaunch.ts`: 345-394, 496, 1023
- `AgentMdJobLoader.ts`: 80, 163, 1513
- `JobLoader.ts:359`, `InstallBuiltinJobs.ts:286`, `PipeSessionSpawner.ts:421`, `JobModelRoute.ts:67-83`
- `PostUpdateMigrator.ts:801` (confirmed only that the line contains `thinkingMode`)

Three things I did not verify: `buildPerSlugManifest.ts:63`, `bugs-overseer` (not in this worktree; my search of the agent home found nothing, so its model and run rate are unconfirmed), and "Rule 30".

The other invariant rows (translate/drop, clamp, ratchet enforcement) hold as invariants.

VERDICT: NOT CONVERGED