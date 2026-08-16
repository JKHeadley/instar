# Side-Effects Review — Codex env-scrubbing (Spec 12 Rule 1a, Pre-Phase A cycle 1)

**Version / slug:** `openai-codex-env-scrubbing`
**Date:** `2026-05-17`
**Author:** Echo (instar developer)
**Second-pass reviewer:** required (touches a security-critical spawn boundary; see Phase 5 section at bottom)

## Summary of the change

Implements the load-bearing structural piece of `specs/provider-portability/12-openai-path-constraints.md` Rule 1a: env-scrubbing at the Codex spawn boundary. Adds `buildCodexChildEnv()` to `src/providers/adapters/openai-codex/transport/codexSpawn.ts` — an explicit allowlist of env vars that flow through to Codex child processes, with hard-delete of `OPENAI_API_KEY` / `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` and pass-through of `OPENAI_BASE_URL` only from a module-level boot-time snapshot. Both transport callers (`oneShotCompletion.ts`, `structuredOneShot.ts`) are switched from `{ ...process.env }` wholesale inheritance to the helper.

Adds a critical-severity startup canary `src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.ts` that injects a sentinel `OPENAI_API_KEY=sk-CANARY` into the test process env and asserts the helper's output never contains the sentinel.

Extends the Rule 3 coverage pre-commit grep (`scripts/check-rule3-coverage.cjs`) with the OpenAI-side pattern set per spec 12 — `OPENAI_API_KEY` identifier, `new OpenAI(`, `openai.chat.completions.create`, `import/require of 'openai'`, LHS assignment to `OPENAI_BASE_URL`. Test-suite fixtures extended in `tests/unit/scripts/check-rule3-coverage.test.ts` (8 new cases covering true-positive and true-negative paths).

Adds a registry row for `codexSpawn.ts` in `06-state-detector-registry.md` ✅ Compliant.

Files touched:
- `src/providers/adapters/openai-codex/transport/codexSpawn.ts` (added `buildCodexChildEnv()` + RULE 3.1 RATIONALE)
- `src/providers/adapters/openai-codex/transport/oneShotCompletion.ts` (switched to helper)
- `src/providers/adapters/openai-codex/transport/structuredOneShot.ts` (switched to helper)
- `src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.ts` (new)
- `scripts/check-rule3-coverage.cjs` (extended pattern set)
- `tests/unit/providers/adapters/openai-codex/codexSpawn-env.test.ts` (new, 12 tests)
- `tests/unit/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.test.ts` (new, 4 tests)
- `tests/unit/scripts/check-rule3-coverage.test.ts` (extended, 8 new cases)
- `specs/provider-portability/06-state-detector-registry.md` (new row)

## Decision-point inventory

- **Codex spawn env construction** — modify — was wholesale `{ ...process.env }` inheritance, now allowlist-only with defensive deletes. Hard-invariant enforcer at a system boundary.
- **Rule 3 pre-commit grep** — modify — added detector patterns for the OpenAI SDK class. Signal layer only; no new blocking authority introduced (the existing human-review step on pre-commit hits is the authority).

No other decision points touched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- An agent that previously set `OPENAI_API_KEY` in its parent shell and relied on automatic inheritance into Codex child processes will no longer have that key reach the child. This is exactly the behavior Rule 1 demands — the path is forbidden. Affected agents are surfaced at adapter init via the Phase A warning behavior (which lands in cycle 2, after this cycle). Mitigation for the cycle-1 window: the kill-switch `INSTAR_DISABLE_RULE1_OPENAI=1` allows the old behavior temporarily.
- An agent that genuinely needs to set a non-allowlisted env var on the Codex child (e.g., a custom proxy header via `CUSTOM_FOO=bar`) will find it scrubbed. Adding to the allowlist requires a spec amendment per spec 12. No known concrete consumer today; flagged for awareness.
- New Rule 3 grep patterns will block PRs that introduce string literals like `"OPENAI_API_KEY"` or the published SDK client construction. Test files (`*.test.ts`) are correctly excluded. Adapter files that use these patterns intentionally (none today besides the just-added `codexSpawn.ts`, which carries its own RULE 3.1 RATIONALE block and matching canary) pass the check.

---

## 2. Under-block

**What failure modes does this still miss?**

- The grep is string-based — domain-string evasions via concatenation (`'OPENAI_' + 'API_KEY'`), computed property access, or dynamic `require()` are not caught at the grep layer. The spec explicitly says this is acceptable because the structural invariant (env-scrubbing) closes the runtime leak path regardless of how the code references the env var name. The grep is a signal for human review, not a blocking authority.
- A future Codex CLI version that reads a NEW env var name (e.g., `OPENAI_AUTH_TOKEN`) for API-key-equivalent billing would not be scrubbed by the current hard-delete list. Mitigation: the canary's vocabulary is documented as living-spec; cycle 2 introduces the `codex auth status --json` runtime probe which would surface this drift.
- A caller that bypasses `buildCodexChildEnv()` and constructs env manually would leak. Mitigation: the CI assertion (cycle 2 deliverable) enumerates spawn callsites; the one-time exhaustive audit at Rule 1a landing closes the existing surface, and the AST-scan gate enforces future additions go through the helper.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

`buildCodexChildEnv()` is at the **system-boundary layer** — it intercepts env right before exec. This is the correct layer for the structural invariant: the Codex CLI honors `OPENAI_API_KEY` from env regardless of what Instar's higher layers know or want, so the only place to enforce "never let the var reach the CLI" is at the env construction site immediately before spawn.

Higher-level alternatives (e.g., a global env-strip at server startup) were considered and rejected: they couldn't handle the kill-switch escape hatch, would interfere with non-Codex env consumers in the same process, and would conflict with the BOOT_OPENAI_BASE_URL snapshot requirement.

Lower-level alternatives (e.g., LD_PRELOAD or a node child_process monkey-patch) were considered and rejected: they invert the dependency direction (Instar adapter would depend on global node state) and would be invisible to callers reading the code.

The helper sits exactly at the spawn boundary, which is the correct layer.

The Rule 3 grep additions sit at the **detector layer** — pure pattern matching, no blocking authority of their own. Signals feed the existing human-review authority on pre-commit hits. This matches the signal-vs-authority principle exactly.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — `buildCodexChildEnv()` has no judgment-based block/allow surface. It's a **hard-invariant validator at a system boundary**, which the signal-vs-authority doc explicitly carves out in its "When this principle does NOT apply" section. The cost of a false-pass (API key leaks) is catastrophic; the cost of a false-block (variable isn't there, which is what we want) is zero in the happy path and surfaced as a Phase A warning in the legacy path. This is in the same class as "rm -rf /" guards — brittle pattern matching is the correct shape.
- [x] No — Rule 3 grep additions produce signals consumed by the existing pre-commit human-review gate. No new blocking authority.

Narrative: this change is structurally aligned. The env-scrub is not adjudicating message content or agent intent — it's enforcing "this specific environment variable must not appear in this specific child process," which is a structural invariant about resource flow, not a judgment about meaning. The grep additions are signal layer per the principle's "Detectors — what's allowed" section (literal/regex matchers in the allowed list).

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None. `buildCodexChildEnv()` runs INSIDE the existing `oneShotCompletion` and `structuredOneShot` execution paths. No check is added in front of an existing check. The Rule 3 grep additions run in the existing pre-commit gate alongside existing patterns.
- **Double-fire:** None. The helper is called exactly once per spawn. Hard-deletes apply on every call, but they're idempotent.
- **Races:** None on the env construction itself — `process.env` reads are synchronous. The `BOOT_OPENAI_BASE_URL` snapshot captures at module load (synchronous, single-threaded in node); there's no race between snapshot and reads.
- **Feedback loops:** None.

Concrete interaction analysis:
- `oneShotCompletion.ts` line 66-69 (old): wholesale `process.env` inheritance + explicit API key set → REPLACED with `buildCodexChildEnv({ apiKey, codexHome })`.
- `structuredOneShot.ts` line 56-58 (old): same pattern → REPLACED.
- `agenticSessionHeadless.ts` and any future tmux-based Codex spawns: NOT TOUCHED in this cycle because tmux owns stdin/env for those paths. The one-time exhaustive callsite audit (cycle 2 deliverable) will explicitly evaluate whether those paths also need the helper.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** No direct effect. Each agent runs in its own process; env-allowlist is per-spawn-call, not process-wide.
- **Other users of the install base:** Users who had `OPENAI_API_KEY` in their shell env AND relied on Codex inheriting it will observe their Codex calls now miss the key. Phase A warning behavior (cycle 2) surfaces this to the user; the kill-switch escape hatch is available immediately for emergency rollback. Pre-cycle-2 visibility is via the canary's structured error.
- **External systems:** No direct effect. Subscription auth path (`~/.codex/auth.json`) is unaffected.
- **Persistent state:** No new persistent state. The boot snapshot is in-memory only.
- **Timing / runtime conditions:** Module-load timing matters for `BOOT_OPENAI_BASE_URL` — captured once. Documented in the spec; cycle 1 implementation matches.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** Pure code change. `git revert` the commit; ship as patch. No data migration. No agent state repair.
- **Data migration:** None. No persistent state changed.
- **Agent state repair:** None. Existing Codex sessions running at revert time continue with their original env; new spawns use the reverted code.
- **User visibility during rollback:** Minor — the canary's pass/fail state would flip back; users observing it via the dashboard would see the change. No functional regression beyond that.
- **Worst-case scenario:** the helper's allowlist is missing a variable Codex genuinely needs (e.g., a new locale variable on a future OS). Symptom is "codex spawns but misbehaves." Mitigation is to add the variable to the allowlist via spec amendment (small follow-up PR). Pre-emptive coverage: the allowlist starts from the union of env vars the prior wholesale-inheritance path passed AND the variables the Codex CLI documentation enumerates as honored.

---

## Conclusion

This change implements the load-bearing structural invariant of Spec 12 Rule 1a. The design is aligned with signal-vs-authority (hard-invariant at system boundary, not judgment), the level-of-abstraction is correct (spawn boundary is the only place this can be enforced), and interactions with existing checks are clean (no shadowing, no double-fire, no races). Rollback is cheap (revert + ship as patch; no persistent state).

The cycle deliberately defers the deprecation-warning and audit-log-writing behavior to cycle 2, where they couple naturally with credential validation. The kill-switch escape hatch is honored in this cycle so existing API-key-configured installs have a runtime path until they migrate.

The change is clear to ship pending second-pass review (see below).

---

## Second-pass review

**Reviewer:** to be conducted via independent subagent (Phase 5).
**Independent read of the artifact:** Concerns raised. The helper itself is correctly structured (allowlist iteration → hard-deletes → kill-switch re-set → caller-override; ordering is right, kill-switch requires both conditions, defensive deletes correctly positioned after iteration, canary verifies sentinel-injection and asserts scrub of all three OpenAI-billing vars including a sanity check that the allowlist iteration isn't silently a no-op). The signal-vs-authority framing is also correct — `buildCodexChildEnv` is a structural invariant at a system boundary, exactly the carve-out in `docs/signal-vs-authority.md` § "When this principle does NOT apply" (safety guards on irreversible actions, hard-invariant validation at the system edge). Concerns are about scope and gates, not the helper's correctness.

1. **CRITICAL — `agenticSessionHeadless.ts` leaks `OPENAI_API_KEY` to Codex today.** The artifact (§ 5 Interactions) says "tmux owns stdin/env for those paths" and defers this callsite to cycle 2. That premise is wrong. `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts:79-80` calls `execFileSync(tmuxPath, tmuxArgs, { encoding: 'utf-8' })` with NO `env:` option, so the tmux process inherits the parent's full `process.env`. tmux `new-session` does NOT scrub env — `-e KEY=VAL` flags ADD to the inherited env, they do not replace it. The Codex CLI launched inside the tmux pane therefore sees `OPENAI_API_KEY` from the parent shell. Worse, line 69 explicitly pushes `OPENAI_API_KEY=<config.apiKey>` via a `-e` flag when set. This is precisely the failure mode Rule 1a was written to prevent, and spec 12 § "Sequencing during the migration window" requires env-scrub to ship in the SAME release as Phase A *before* warning behavior — landing cycle 1 without covering this path leaves a working leak path live in production. **Resolution:** before this cycle merges, either (a) add a tmux-aware variant of `buildCodexChildEnv` and pass the result via `env:` plus pruned `-e` flags in `agenticSessionHeadless.ts`, or (b) explicitly scope the cycle 1 PR to disable `agenticSessionHeadless` until cycle 2 lands. The "deferred to cycle 2" framing in § 5 is not a defense — the spec's exhaustive-callsite-audit clause exists specifically to prevent this kind of partial landing.

2. **CRITICAL — `Config.ts:buildProviderEnvFlags` is a second leak path the artifact doesn't mention.** `src/core/Config.ts:419-427` emits `-e OPENAI_API_KEY=<value>` flags consumed by `SessionManager.ts`'s interactive-session spawn (line 1326+). This is a Codex spawn path that bypasses `buildCodexChildEnv` entirely. The artifact's "Files touched" and "Concrete interaction analysis" sections do not enumerate this callsite. The one-time exhaustive callsite audit required by spec 12 § "One-time exhaustive callsite audit at Rule 1a landing" — "EVERY existing `codex`-exec'ing callsite in the repo (including test harnesses, debug helpers, and `child_process.exec/spawn/spawnSync` wrappers)" — was not performed. **Resolution:** run the audit before merge; either gate `buildProviderEnvFlags`'s openai branch behind the kill-switch + audit log, or route interactive Codex spawns through the helper.

3. **HIGH — Rule 3 grep false-positives in legacy files.** The new `\bOPENAI_API_KEY\b` pattern will fire on `src/core/Config.ts:387,420,422` and `src/core/types.ts:16` on any future commit that touches those files; the new `\bOPENAI_BASE_URL\b\s*=` pattern will fire on `Config.ts:425`. None of these files carry a `RULE 3: EXEMPT` marker. The legitimate code path (assigning to a flags array, not assigning to `process.env`) is indistinguishable to the regex from a real Rule 1 violation. **Resolution:** either (a) add a `RULE 3: EXEMPT — legacy provider-env helper, scheduled for removal at Phase B per spec 12` comment to `Config.ts` and `types.ts` in the same PR, or (b) tighten the assignment regex to match `process.env.OPENAI_BASE_URL =` only, not arbitrary identifier assignment. The artifact's "Test files (`*.test.ts`) are correctly excluded. Adapter files that use these patterns intentionally (none today besides the just-added `codexSpawn.ts`)..." claim is factually incorrect — `Config.ts` and `types.ts` use these patterns intentionally and are not excluded.

4. **LOW — Caller-provided `options.apiKey` correctly overrides the kill-switch path** (lines 158-161 run after lines 149-156), confirming the artifact's claim on that point. Kill-switch requires BOTH `INSTAR_DISABLE_RULE1_OPENAI=1` AND a non-empty parent `OPENAI_API_KEY` (lines 150-154); neither alone leaks. Hard-deletes (145-147) win over any future allowlist regression because they run after the iteration. These all check out.

5. **LOW — Sanity-check in the canary is well-designed** (lines 86-91 catch the vacuous-pass case where allowlist iteration is no-op'd). Restoration of parent env in `finally` is correct. Kill-switch is explicitly cleared before the assertion so the canary doesn't pass-through accidentally.

**Verdict:** Concern raised — concerns 1 and 2 are blocking. The helper is correct in isolation, but the cycle ships partial coverage: at least one (and likely two) Codex spawn paths still leak `OPENAI_API_KEY` after this lands, which is the exact regression Rule 1a exists to prevent. The artifact's signal-vs-authority analysis is sound, but its callsite enumeration is incomplete relative to what spec 12 § "One-time exhaustive callsite audit at Rule 1a landing" requires. Recommend either expanding cycle 1 to cover `agenticSessionHeadless.ts` + the `Config.ts` provider-env helper, or explicitly disabling those paths until cycle 2 closes them.

Note: this change touches a security-critical spawn boundary and modifies session-spawn behavior — qualifies for Phase 5 second-pass per the `/instar-dev` skill's enumeration. The reviewer will be a fresh subagent reading this artifact + the spec + the modified files independently.

---

## Evidence pointers

- Approved spec: `specs/provider-portability/12-openai-path-constraints.md` (review-convergence stamped 2026-05-17, approved by Justin 2026-05-17).
- Convergence report: `docs/specs/reports/openai-path-constraints-convergence.md`.
- Unit tests: 32 tests pass across `codexSpawn-env.test.ts` (12), `openaiKeyLeakageCanary.test.ts` (4), and `check-rule3-coverage.test.ts` (16, including 8 new for OpenAI patterns).
- Test run: 2026-05-17 13:52 — all green in 2.5s.
- TypeScript compile: `npx tsc --noEmit` clean across the worktree.

---

## Cycle 1.1 — Fixes for Second-Pass Review Concerns

The three concerns raised in the second-pass review are now addressed in
the same cycle 1 commit. Cycle 1 does NOT ship until a fresh second-pass
reviewer concurs with this section.

### Concern 1 fix — `agenticSessionHeadless.ts` tmux spawn no longer leaks

**Files changed:**
- `src/providers/adapters/openai-codex/transport/codexSpawn.ts` — added a
  sibling helper `buildCodexTmuxSessionEnv(options)` that emits
  `[key, value]` tuples for tmux `-e VAR=VAL` flags from the same Rule 1a
  allowlist shape. Caller-supplied `extraEnv` is filtered through
  `SESSION_EXTRA_ALLOWLIST`; `OPENAI_API_KEY` / `OPENAI_ORG_ID` /
  `OPENAI_PROJECT_ID` are hard-blocked even if a future allowlist
  expansion mistakenly lets them in.
- `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts`
  — `OpenAiCodexAgenticSession.start()` now:
  1. Builds `sessionEnv` via `buildCodexTmuxSessionEnv()` (passes
     `INSTAR_SESSION_ID`, `CODEX_HOME` if configured, and filters
     `options.env`).
  2. Removes the previous explicit `OPENAI_API_KEY` push from
     `this.config.apiKey` — the raw-API-key path is forbidden per
     Spec 12 Rule 1.
  3. Passes `env: buildCodexChildEnv({ codexHome })` to
     `execFileSync(this.config.tmuxPath, ...)` so tmux's own inherited
     env is scrubbed before tmux spawns the Codex child. The `-e` flags
     then layer session-specific overrides on top of the scrubbed env.

**Tests added** (`tests/unit/providers/adapters/openai-codex/agenticSessionHeadless-env.test.ts`):
6 tests, all green. Mock `execFileSync` to capture the env object + the
tmux args, then assert:
- The env passed to `execFileSync(tmuxPath, ...)` does NOT contain
  `OPENAI_API_KEY` / `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`.
- The `-e` flag tuples never contain `OPENAI_API_KEY=...`, even when
  `config.apiKey` is set.
- `CODEX_HOME` is emitted via `-e` when configured.
- `INSTAR_SESSION_ID` is emitted on every spawn.
- Caller-supplied `OPENAI_API_KEY` in `options.env` is dropped.
- Allowlisted `CODEX_DEFAULT_MODEL` in `options.env` is admitted.

**Tests extended** (`tests/unit/providers/adapters/openai-codex/codexSpawn-env.test.ts`):
8 new tests for `buildCodexTmuxSessionEnv` (allowlist semantics, hard
blocks for `OPENAI_*_ID` vars, fresh-array per call). File total goes
from 12 to 20 tests.

### Concern 2 fix — `buildProviderEnvFlags` refuses openai api-key path

**Files changed:**
- `src/core/Config.ts` — the `'openai'` case in `buildProviderEnvFlags`
  now THROWS when `credential.kind === 'api-key'`, pointing at
  `specs/provider-portability/12-openai-path-constraints.md`. The
  function no longer emits `-e OPENAI_API_KEY=<value>` under any
  circumstance. `OPENAI_BASE_URL` emission is preserved for the
  legitimate OAuth + user-proxy case. The error message does NOT include
  the credential value (verified by a dedicated test).

**Tests updated** (`tests/unit/providerCredentials.test.ts`):
- Replaced the "emits OPENAI_API_KEY" test with a "REFUSES api-key
  credential" test asserting the throw + spec reference in the error.
- Added test asserting `OPENAI_BASE_URL` is still emitted for the
  oauth-token + baseUrl case.
- Added test asserting the credential value never appears in the
  refusal error message.

All 16 tests in the file pass.

**Audit note:** A grep for `buildProviderEnvFlags` callers found ZERO
non-test callers in `src/` today (the original second-pass artifact's
claim of "consumed by SessionManager.ts:1326+" did not match the
current source). The function is currently unused in production, but
the refusal is structural so any future caller that attempts the
api-key path fails loudly instead of silently leaking.

### Concern 4 fix — `CodexCliIntelligenceProvider.ts` env inherit

A second-pass reviewer (run after the cycle 1.1 patches above) caught
that `src/core/CodexCliIntelligenceProvider.ts:81-87` was building
`childEnv = { ...process.env }` then calling
`execFile(this.codexPath, args, { env: childEnv, ... })` — a wholesale
inherit pattern that leaked `OPENAI_API_KEY` into the Codex child for
every reviewer/canary/sentinel call. Same class of failure as Concern
1, at a callsite outside the openai-codex adapter directory.

**Files changed:**
- `src/core/CodexCliIntelligenceProvider.ts` — `childEnv` is now
  produced by `buildCodexChildEnv()` (imported from the adapter's
  transport module). The previous explicit `delete childEnv.CLAUDECODE`
  / `delete childEnv.CLAUDE_SESSION_ID` calls become redundant (those
  vars aren't in the allowlist), but the hygiene intent is preserved.

**Tests added** (`tests/unit/core/CodexCliIntelligenceProvider-env.test.ts`):
4 tests, all green. Mock `execFile`, set sentinel
`OPENAI_API_KEY=sk-PARENT-LEAK-SENTINEL` in parent env, then assert:
- The env passed to `execFile` does NOT contain `OPENAI_API_KEY` /
  `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`.
- The env has fewer than 50 keys (regression guard against returning
  to the inherit-wholesale pattern, which would carry hundreds).
- The kill-switch path still works: with
  `INSTAR_DISABLE_RULE1_OPENAI=1` set, `OPENAI_API_KEY` is re-admitted
  per the helper's escape-hatch contract.
- `CLAUDECODE` and `CLAUDE_SESSION_ID` are dropped via allowlist
  semantics (replacing the prior explicit deletes).

### Exhaustive Codex-spawn callsite audit (cycle 1.1)

Per Spec 12 § "One-time exhaustive callsite audit at Rule 1a landing",
every callsite in `src/` that spawns the `codex` CLI binary has been
enumerated and verified to route through `buildCodexChildEnv()` (or
its tmux-aware sibling `buildCodexTmuxSessionEnv()`):

| File:line | Callsite shape | Status |
|-----------|----------------|--------|
| `src/core/CodexCliIntelligenceProvider.ts:89` | `execFile(this.codexPath, ...)` | FIXED in this PR (Concern 4) |
| `src/providers/adapters/openai-codex/transport/oneShotCompletion.ts:79` | `spawnCodexAndWait(this.config.codexPath, ..., { env: buildCodexChildEnv(...) })` | clean (cycle 1) |
| `src/providers/adapters/openai-codex/transport/structuredOneShot.ts:95` | `spawnCodexAndWait(this.config.codexPath, ..., { env: childEnv })` where `childEnv = buildCodexChildEnv(...)` (line 58) | clean (cycle 1) |
| `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts:80` | `tmuxArgs.push(this.config.codexPath, ...)` then `execFileSync(tmuxPath, tmuxArgs, { env: buildCodexChildEnv(...) })` with `-e` flags from `buildCodexTmuxSessionEnv()` | FIXED in this PR (Concern 1) |

Callsites verified NOT to spawn the Codex binary (control-plane only,
operate on already-running tmux sessions):
- `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts:95` (`set-option ... history-limit` on existing session)
- `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts:131` (`spawn(tmuxPath, ['has-session', ...])`)
- `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts:140` (`execFileSync(tmuxPath, ['capture-pane', ...])`)

The tmux server inherits the scrubbed env at new-session time (the
fixed callsite at :80); control-plane calls to the running server
don't spawn new Codex processes and don't need a passed env. The
fresh second-pass reviewer concurred this is safe.

Test-only spawn callsites are not enforced by Rule 1a (the spec's
"production code paths" scope) but are reviewed for hygiene during
PR review.

### Concern 3 fix — Rule 3 grep tightened to LHS assignments only

**Files changed:**
- `scripts/check-rule3-coverage.cjs` — the OPENAI_API_KEY pattern is
  tightened from `\bOPENAI_API_KEY\b` (matched any occurrence) to
  `\bOPENAI_API_KEY\b\s*=\s*[^=\s]` (matches LHS assignments and
  template-literal emissions; NOT comparisons, type declarations,
  reads, or `delete env.OPENAI_API_KEY` calls). The `[^=\s]` tail
  rejects doc-string trailing content. Added `!f.endsWith('_smoketest.ts')`
  to the source-file filter so the CLI smoketest tool's usage strings
  (`OPENAI_API_KEY=sk-...`) don't false-positive.

**Tests updated** (`tests/unit/scripts/check-rule3-coverage.test.ts`):
Replaced the "flags any OPENAI_API_KEY occurrence" test with seven
targeted tests:
- Does NOT flag plain reads of `process.env.OPENAI_API_KEY`.
- Does NOT flag `delete env.OPENAI_API_KEY`.
- Does NOT flag type declarations `OPENAI_API_KEY?: string`.
- Does NOT flag `=== 'string'` comparisons.
- Flags `env.OPENAI_API_KEY = value` (LHS assignment).
- Flags `process.env.OPENAI_API_KEY = value` (env mutation).
- Flags `` `OPENAI_API_KEY=${v}` `` (template-literal emission).

All 22 tests in the file pass (was 16, replaced 1 + added 7).

**Effect on legacy files:** `src/core/Config.ts` (lines 387, 420, 422,
425 — reads/comments) and `src/core/types.ts:16` (a doc comment) no
longer trip the gate. They never carried EXEMPT markers; under the
tightened pattern they don't need to.

### Verification

```
npx vitest run \
  tests/unit/providers/adapters/openai-codex/codexSpawn-env.test.ts \
  tests/unit/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.test.ts \
  tests/unit/providers/adapters/openai-codex/agenticSessionHeadless-env.test.ts \
  tests/unit/core/CodexCliIntelligenceProvider-env.test.ts \
  tests/unit/providerCredentials.test.ts \
  tests/unit/scripts/check-rule3-coverage.test.ts
```

Result: 72 tests pass (20 + 4 + 6 + 4 + 16 + 22). `npx tsc --noEmit` clean.

### Second-pass review (fresh) — outcome

Two fresh independent second-pass reviews were run on cycle 1.1:

**Round A** (after addressing Concerns 1, 2, 3) — verdict
**CONCERN-RAISED**: Concerns 1/2/3 closed but a NEW callsite was
found (`src/core/CodexCliIntelligenceProvider.ts:81-87` — wholesale
`{...process.env}` then `execFile(this.codexPath, ...)`). Logged as
Concern 4 above.

**Round B** (after addressing Concern 4 + adding the exhaustive
callsite-audit table) — verdict **CONCUR**: Concern 4 is closed
(`buildCodexChildEnv()` is called, sentinel-injection tests cover the
scrub path, kill-switch contract honored, allowlist semantics drop
CLAUDECODE/CLAUDE_SESSION_ID). The audit table at "Exhaustive Codex-
spawn callsite audit (cycle 1.1)" was verified complete against
grep of `this.codexPath` / `config.codexPath` / `codex exec` /
`codexBin` across `src/`. Three minor observations (LOW: core→adapter
import direction is consistent with existing file pattern, LOW: mock
contract matches usage, MEDIUM: kill-switch test verifies helper
contract not end-to-end-child-process — acceptable scope for unit
tests at this boundary) — none blocking.

**Verdict:** CONCUR — cycle 1 ready to commit.
