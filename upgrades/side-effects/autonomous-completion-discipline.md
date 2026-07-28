# Side-Effects Review — Autonomous Completion Discipline

**Version / slug:** `autonomous-completion-discipline`
**Date:** `2026-06-09`
**Author:** `echo`
**Second-pass reviewer:** `not required (operator runs the independent adversarial implementation review)`

## Summary of the change

Structural enforcement of "don't stop a pre-approved autonomous run early" (the Tier-2 half of PR #1025's prose allowlist). Three pieces: (1) `CompletionEvaluator` (`src/core/CompletionEvaluator.ts`) gains an optional `StopSignals` object on `evaluate()` + `evaluateStopRationale()`, fences the agent-authored transcript as instruction-inert data, renders an objective-signals + milestone block only when signals are present, adds the external-vs-buildable hard-blocker classification, and stamps `p13ProtocolVersion: 2` on every P13 response; `PROMPT_VERSION` bumped to `completion-eval-v2`. (2) The routes `/autonomous/evaluate-stop` + `/autonomous/evaluate-completion` (`src/server/routes.ts`) parse the optional `signals`/`stopKind` and stamp `p13ProtocolVersion` (+ `classifiedBlocker`) on block/allow/503/500. (3) The autonomous stop hook (`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`) computes deterministic checkbox (3-state) + milestone + injection scans over the judge's `tail -6` window, fires the completion judge only on a might-be-done iteration, folds P13 into the completion judge on the condition path (single critical-path call), adds a nonce-gated `<hard-blocker>` `(a)` exit branch (final-turn-only, all-fields, fence/template-ignore, leak-scrubbed, P13 external-vs-buildable gated, version-skew three-case detection), a circuit-breaker + verdict-cache sidecar, a fail-open `evaluator-unreachable-exit` record-and-CONTINUE path, and an off-switch (`autonomousSessions.completionDiscipline.enabled` + `judgeTimeoutMs`) read at the chokepoint. Config defaults (`src/config/ConfigDefaults.ts` + type in `src/core/types.ts`), SKILL.md + setup-autonomous.sh template/nonce/bounded-duration changes, PostUpdateMigrator marker bumps, and a CLAUDE.md-template awareness paragraph (`src/scaffold/templates.ts`) round it out.

## Decision-point inventory

- `CompletionEvaluator.evaluateStopRationale` (extended P13 authority) — modify — now signal-fed + classifies external-vs-buildable; still an LLM authority, still fails open.
- `CompletionEvaluator.evaluate` (completion authority) — modify — accepts folded signals on the condition path; verdict semantics unchanged.
- `autonomous-stop-hook.sh` `(a)` hard-blocker branch — add — NEW exit path, itself P13-gated (necessary-but-not-sufficient).
- `autonomous-stop-hook.sh` deterministic scans (checkbox / milestone / injection) — add — DETECTORS only; they feed the authorities, never block alone.
- `autonomous-stop-hook.sh` circuit-breaker + verdict cache — add — bounds judge spend; cheap path is always continue (never a fail-open exit).
- `/autonomous/evaluate-stop` + `/autonomous/evaluate-completion` — modify — signal passthrough + protocol stamp; backward-compatible.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only thing newly blockable is an *un-justified, condition-unmet, pre-approved* exit. Every legitimate exit is preserved: `(b)` duration expiry and emergency-stop run BEFORE all new logic and are untouched; `(c)` a genuinely-met condition exits (the judge's all-things-considered verdict); `(a)` a nonce-valid hard-blocker the P13 judge classifies external exits cleanly. A genuine external blocker (a credential that does not exist, a down service) is the explicit `(a)` allow case. Potential over-block: an agent that genuinely hits an external blocker but forgets the nonce'd `<hard-blocker>` marker is re-fed rather than exited — but it keeps working until duration expiry (never trapped), and the SKILL.md documents the marker. The deterministic scans never block on their own (signal-only), so a false milestone-phrase match cannot block — it only adds scrutiny the LLM authority weighs.

---

## 2. Under-block

**What failure modes does this still miss?**

The honest limitation (§3.1 of the spec): the judge reads an ~8KB prose transcript and cannot run `tsc`/tests/inspect the FS, so an agent that *writes* "ran tsc, 412 tests pass" into its transcript can fool the completion judge even if nothing ran. Mitigations (artifact-grounded conditions; the operator reads the hard-blocker rows + reports) make a fabrication cheap to detect, P13-gated, and impossible to make silently — they do not make it impossible. A coherent fabricated hard-blocker that P13 *also* judges external would exit, but it leaves an auditable, /ack-able row + Telegram the operator can refute. The inline credential-leak scan covers the common key/token/PEM/bearer shapes but is not exhaustive.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The deterministic scans are DETECTORS (cheap, brittle, no I/O) that FEED the existing P13 + completion LLM AUTHORITIES (context-rich, reasoning). The hook's `decision: block` is session-lifecycle MECHANICS (explicitly listed under signal-vs-authority's "when this principle does NOT apply"), not a message-meaning judgment — it asks the authorities and enforces their verdict. The one new code path (the `(a)` marker branch) is itself authority-gated by P13. No new gate is invented; the change refines WHEN the existing P13 authority blocks and feeds it new structural signals.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces signals consumed by existing smart gates (the completion evaluator + the extended P13 guard, both full-context LLM authorities). The one new exit path is itself P13-gated.

The checkbox/milestone/injection scans are validators that emit booleans/counts; they never block or allow on their own. The completion evaluator is the primary authority over "is the work done?"; the extended P13 guard is the secondary authority over "is this stop earned?" and "external or buildable?". Both fail safe (completion → keep working; P13 → fail open, and on the `(a)` path the absence of an explicit `external` classification is treated as not-a-clean-allow by the hook's three-case detection).

---

## 5. Interactions

- **Shadowing:** the `(a)` hard-blocker branch is placed AFTER emergency + duration and BEFORE the completion/promise blocks, so `(b)`/emergency always win. A contradictory-markers turn (hard-blocker + completion token) sets `CD_BLOCK_TERMINAL=true` which suppresses the downstream completion/promise exits — verified by the contradictory-markers test (without it the promise block would have exited).
- **Double-fire:** the `(a)` exit removes the state file before returning, so the row + Attention item + notify fire exactly once per run (state removal prevents re-append). The Attention item id is keyed on topic+started_at so a re-fire within a run reuses the id (the store de-dups).
- **Races:** the breaker + verdict-cache live in the existing per-topic backoff sidecar (`${STATE_FILE%.md}.backoff.json`); writes are tmp-then-mv. No new shared state beyond that sidecar + the per-run hard-blocker log.
- **Feedback loops:** the judge fires only on a might-be-done iteration; the common keep-working iteration costs zero LLM (the existing invariant is preserved), so no O(turns) spend loop is introduced.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the hook is per-session, per-topic.
- **Install base:** existing agents receive the new hook/SKILL.md/setup via the three PostUpdateMigrator marker bumps (`COMPLETION_DISCIPLINE` / `COMPLETION_CONDITION_DEFAULT`); config via `ConfigDefaults.SHARED_DEFAULTS` (add-missing). New agents get it via init + the CLAUDE.md-template paragraph.
- **External systems (Telegram):** the `(a)` exit sends ONE `notify_terminal_stop` Telegram (reuses the existing path) + raises ONE source-tagged (`autonomous-hard-blocker`) Attention item deduped by the Topic-Flood Guard / Bounded Notification Surface — so the notification-flood burst-invariant CI test stays green (verified).
- **Persistent state:** new `logs/autonomous-hard-blocker.jsonl` (coarse-rotated) + the per-run `hard_blocker_nonce` frontmatter field + the breaker keys in the backoff sidecar. Nothing destructive.
- **Server prompt extension** is UNCONDITIONALLY backward-compatible (omits the new blocks when no signals), so a server that updates ahead of the hook is a no-op until a flag-on hook sends signals.

---

## 7. Rollback cost

- **Hot-fix / flag:** the single flag `autonomousSessions.completionDiscipline.enabled: false` disables the whole hook-side change at the next stop (no restart). It reverts to the prior promise/condition + prior P13 path.
- **Data migration:** none. The new log + sidecar keys + frontmatter field are additive and inert when the flag is off.
- **Agent state repair:** none — all changes fail-toward-continue; worst case on misbehavior is one extra continue iteration (the safe direction).
- **User visibility:** no regression during rollback — the server prompt extension is signal-gated, so a revert is a no-op for old hooks.

The registered Stop-hook `timeout` is deliberately NOT touched (it stays `10000` seconds ≈ 2.8h — effectively no timeout, the correct value for a loop-driver hook; lowering it would kill the 300s idle-backoff sleep mid-flight). No `migrateSettings()` timeout migration is added.

---

## Conclusion

The review confirms the change adds no new brittle blocker: every new blocking decision is made by a full-context LLM authority fed by detector signals, and the one new exit path (the `(a)` marker branch) is itself P13-gated. Two design points surfaced during the build and were closed: (1) the contradictory-markers case needed an explicit `CD_BLOCK_TERMINAL` suppressor so the also-present completion token can't exit out from under the contradiction; (2) the inline credential-leak guard is a regex (not a shell-out) because the existing credential-leak-detector is a PostToolUse hook skill, not a callable scanner — flagged below as the one deviation from the spec. The feature ships `enabled:true` per the operator's explicit mandate, with the flag for instant rollback. Clear to ship pending the operator's independent adversarial implementation review.

---

## Second-pass review (if required)

**Reviewer:** not required — the operator runs the independent adversarial implementation review after this commit (per the task instruction).

---

## Evidence pointers

- Tier 1: `tests/unit/CompletionEvaluator-completion-discipline.test.ts` (16), `tests/unit/autonomous-stop-hook-completion-discipline.test.ts` (23).
- Tier 2: `tests/integration/autonomous-evaluate-stop-signals.test.ts` (9).
- Tier 3: `tests/e2e/autonomous-completion-discipline-lifecycle.test.ts` (3).
- Regression-adjacent green: `autonomous-completion-condition`, `autonomous-stop-hook-notify`, `autonomous-stop-hook-idle-backoff`, `PostUpdateMigrator-autonomousStopHook`, `notification-flood-burst-invariant`, `ConfigDefaults`.
- `npx tsc --noEmit` clean; `npm run lint` clean.

### Spec deviations (flagged, not silent)

1. **Inline credential-leak regex instead of a shell-out to the credential-leak-detector.** The spec (§2b.3 step 3) anticipated this: the existing detector is a PostToolUse hook *skill*, not a callable scanner, so the hook runs a lightweight inline regex over the three marker fields covering the same pattern families (API-key / token / PEM / bearer). This matches the spec's own §5 deviation note.
2. **Version-skew three-case + live-curl `(a)` paths are exercised via the `INSTAR_HOOK_P13_OVERRIDE` seam, not a live mock HTTP server**, because the sandbox blocks localhost curl from the test harness (verified `rc 28` to an in-process 127.0.0.1 server). The branch logic is fully covered by the seam (added `old-server` / `timeout` override values); the route side of the protocol stamp is covered by the Tier-2 integration test. The seam is a test-only path; production uses the real curl + route.
