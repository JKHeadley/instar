# Side-Effects Review — terminal-input outcome label for PromptGate prompt-detect (CMT-1677)

**Version / slug:** `jev-prompt-detect-outcome`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (PromptGate is a gate; SessionManager write guard touched) — see bottom`

## Summary of the change

Tier 1 (9 runtime/test files changed + 1 new runtime module, ~260 changed LOC plus ~400 LOC of new tests; one design pass plus one fix round from the second-pass review and a failing integration assertion; first commit attempt). CMT-1677, brief `.instar/jev-reassessment-20261114/cmt-1677-label-brief.md`.

Gap 1 (no outcome label): new `src/monitoring/PromptDetectOutcomeObserver.ts` — in-memory, one observation per session, horizon H = 15 min, cap 64 sessions. `InputDetector.llmDetect` (src/monitoring/PromptGate.ts), only while the Jev prompt-detect point is on, adds `provenance.onCorrelationId` to the incumbent call, tracks the snapshot's bottom-5-line fingerprint under that router-minted id, and records the incumbent's verdict when it settles. `onCapture` feeds pane fingerprints, `cleanup` → `session-ended`, `onInputSent` and a new `noteSessionInput` → input. `SessionManager.confinedWriteRefused` (the guard every SessionManager tmux write and the server's `tmuxOps.sendKeys` already pass) calls `noteSessionInput` when the write is allowed. One outcome row per snapshot goes through `annotateDecisionOutcome` (the §5.4 chokepoint) under two new PromptGate-owned rules: `terminal-prompt-progressed-v1` (pane changed, no input → right for no-prompt, wrong for blocking, unknown if the incumbent call failed) and `terminal-prompt-unresolved-v1` (input-while-unchanged = candidate, unchanged-no-input / session-ended / observer-lost = unresolved, all `unknown`). Both rungs are `deterministic-ground-truth` with `negative-evidence` strength. `JevFirstDecision.decide` takes an optional `link()`; the Jev row gets `producerCorrelationId` as a top-level row field (`JudgmentProvenanceLog`, validated) and `sessionName` in context; PromptGate passes it. Shutdown disposes open observations as `observer-lost`.

Gap 2 (identity): `DP_PROMPT_INJECTION_DETECT='prompt-injection-detect'` → `DP_TERMINAL_PROMPT_DETECT='terminal-prompt-detect'`, prompt id `prompt-injection-detect-v1` → `terminal-prompt-detect-v1`. Prompt text, model and PromptGate's actions unchanged. `DECISION_POINT_ALIASES` + `canonicalDecisionPoint()` in the census; `getCensusEntry` resolves aliases; `GET /decision-quality` canonicalizes stats, grade breakdown, expired counts and rollup counters before grouping, so older rows count under the new id. The census entry drops `gradingPosture: 'measurement-only'` because it now has rules (the ratchet refuses both together).

## Decision-point inventory

- `terminal-prompt-detect` (PromptGate incumbent) — modify (rename + outcome rules). What PromptGate does with the answer is unchanged.
- `prompt-detect` (Jev shadow) — modify (two added context fields, new `gradingGap` label). Still shadow-only.
- SessionManager write guard — pass-through (adds an observation call; refusal verdict unchanged, computed by the same body now named `confinedWriteRefusedVerdict`).

## 1. Over-block

No block/allow surface — the observer only records. The write guard returns the identical verdict; the added call is in try/catch.

## 2. Under-block

Mislabels the evidence can still carry (why the strength is `negative-evidence`, not proof):
- A real blocking modal whose bottom five lines contain a live clock or spinner changes without input → `progressed-without-input`, grading a correct "blocking" verdict wrong.
- Input that does not pass SessionManager's write guard is not seen: the operator's Telegram `/interrupt` Escape (direct `execFileSync` in server.ts), a human typing in an attached tmux client, and provider-adapter writers outside SessionManager. Such input followed by a pane change is read as progress without input. All are rare on PromptGate-monitored sessions.
- A crash (not a graceful shutdown) loses the in-memory observations; those decisions have no outcome row and read as ungraded / expired, never as passes.
- One observation per session: a second snapshot on the same session before the first resolves supersedes it (`observer-lost`, `lostReason: superseded`).
- One-sided measurement (second-pass finding A): `progressed-without-input` is the only grading kind and it says "not blocking", so `blocking` verdicts can only grade wrong and `no-prompt` verdicts only right. This point's right/(right+wrong) counts incumbent false alarms; it can NOT detect an incumbent miss (the brief's Codex "content can't be shown" menu that got `NO_PROMPT` ends `input-while-unchanged` or `unchanged-no-input`, graded unknown). Positive labels need a different, stronger signal; this change does not provide one.
- Writers outside the guard (second-pass finding C): besides `/interrupt`, the Codex adapter's `interactivePromptObserver.respond()` sends raw keys. Verified 2026-11-15: nothing in `src` calls that `respond()`, so it cannot reach PromptGate-monitored sessions today; if it is ever wired, it must go through SessionManager's write guard. A tmux resize or a client attach can reflow the bottom five lines with no input.
- The horizon is enforced on the next capture or input (`sweep()`), so with no captures an observation can outlive 15 minutes; it still closes `unchanged-no-input` with the true elapsed time.

## 3. Level-of-abstraction fit

Right layer. PromptGate already owns the pane captures and the input/cleanup callbacks, so it is the only place that sees snapshot, change and input together. Outcomes use the existing correlation-id seam and annotate chokepoint (no new store, no new id). Input detection sits at the existing single write guard rather than at each writer.

## 4. Signal vs authority compliance

Pure signal (`docs/signal-vs-authority.md`): the observer and the link fields feed the decision-quality read surface; neither holds authority over PromptGate, the session, or any message. The incumbent stays the sole authority, and the Jev point stays clamped to shadow.

## 5. Interactions

- `onInputSent` now also notes input; it already ran for every relay/approval path. Double notification (guard + onInputSent) is idempotent: the first finishes the observation.
- `confinedWriteRefused` gained a side effect; every caller writes right after an allowed verdict, so "allowed" = "input about to be sent". A write that then fails still counts as input (the conservative direction: it can only suppress a `progressed` label).
- The router fires `onCorrelationId` synchronously at mint; if a wrapper ever delays it, tracking starts when the incumbent settles, still against the snapshot fingerprint.
- Verdict race (second-pass finding B, fixed): a pane change or input that arrives while the incumbent call is still running is HELD (first event wins) and recorded when the call settles, with its verdict and the event's own elapsed time. So the grade uses the verdict, and the outcome never lands before the router has written its decision row (no false `orphanOutcomes`). A call that fails records the held event ungraded; a call that never settles closes at the horizon.
- Join key placement: the served-context credential scrub masks id-shaped values (`d-<uuid>` became `[TOKEN:d-1b****]` in a probe), so `producerCorrelationId` is a validated TOP-LEVEL provenance-row field (`JudgmentProvenanceLog.validProducerCorrelationId`: `^[db]-[A-Za-z0-9-]{1,100}$`, else dropped), added to the pool-merge field allowlist; it does not make the Jev row a seam row (no label clamps). `sessionName` stays in context.
- `findGradingContradictions` / `findWiredWithoutGraders`: the point now has rules and no posture, so both stay clean (ratchet test updated).
- The decision-grading pass only walks rules owned by `DecisionGrading`; the new rules are owned by PromptGate and are not touched by it.
- The `/decision-quality` "expired" derivation uses the 6 h evidence window; a 15-minute rule always lands well inside it.

## 6. External surfaces

- New rows on `GET /decision-quality` (rule ids, grades) and outcome rows on `GET /judgment-provenance` (ids, enums, numbers; no pane text — verified by the integration test).
- The incumbent decision point id changes fleet-wide for NEW rows (`terminal-prompt-detect`). Anything filtering raw rows by the old string sees only history; the in-repo readers alias it. `docs/research/jev/jev-first-inventory.md` still quotes the old id as history.
- One new top-level provenance-row field (`producerCorrelationId`) and one new Jev-row context field (`sessionName` — a tmux session name, not content).

## 7. Multi-machine posture

Machine-local by design: an observation lives on the machine whose PromptGate captured the pane, joined to that machine's own decision row; outcomes travel wherever decision-quality rows already travel. A session moved to another machine ends locally → `session-ended`. A peer on an older version still records `prompt-injection-detect`; this machine's reader aliases it. No user-facing notices.

## 8. Rollback cost

Revert the commit. Outcome rows already written stay as ordinary `decision_outcomes`/JPL rows under rule ids older code does not register (ignored by its readers). Rows recorded as `terminal-prompt-detect` would appear as an unknown point to a reverted reader until they age out. No migration, no config.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose)
**Verdict:** Concur with the review. The code is safe and the grades are honest. The residual-risk list is missing three items (below); none of them blocks the merge.

- Authority (audit 1): every observer call in `InputDetector.onCapture`, `cleanup`, `onInputSent`, `noteSessionInput` and `SessionManager.confinedWriteRefused` (src/core/SessionManager.ts:7399-7408) sits in try/catch and returns nothing PromptGate uses. The refusal verdict is still computed by the unchanged body, now `confinedWriteRefusedVerdict`. The observer's `annotate` is wrapped too. No write is delayed: the added work is a Map lookup plus, at most, one synchronous SQLite upsert that `finish()` already guards. `isConfinedWriteRefused` has one caller (server.ts:21051 `tmuxOps.sendKeys`), and that caller writes right after it, so "allowed" really does mean "input is coming".
- Gate off (audit 2): `jevPointActive()` is false, so the call gets no `onCorrelationId`, `observeSnapshot` is never called and `shadowJev` gets no `link`. The incumbent call differs only by the renamed `decisionPoint` and `promptId`. The observer is still built in server.ts and `onPane` still runs, but with nothing tracked its `sweep()` is a no-op. The unit test "gate off" pins this.
- Grade honesty (audit 3): only `progressed-without-input` with a known verdict grades (PromptDetectOutcomeObserver.ts:167). The mapping is right: the pane changed with no input, so "no-prompt" grades right and "blocking" grades wrong. One correlation id cannot get two rows: `finish()` deletes the entry before it annotates, the `tracked` flag in `observeSnapshot` stops a re-track, `track()` ignores a repeat of the same id, and `decision_outcomes` is UNIQUE(correlation_id, graded_by). The id is always the one the router minted (`mintDecision` fires `onCorrelationId` synchronously). With no id, nothing is tracked.
- Bounds (audit 4): at most 64 entries, one per session. Each entry ends by eviction, being superseded, the horizon, input, the session ending, or dispose. Closures held by the incumbent `.then` are released when that promise settles. No leak found. One caveat: the horizon is only enforced by `sweep()` on the next capture or input, so with no captures an entry can outlive H. It still closes as `unchanged-no-input`, with the real `elapsedMs`.
- Alias (audit 5): `/decision-quality` puts stats, breakdown, expired counts and the rollup through `canonicalDecisionPoint` before grouping. It then sums by point (routes.ts loops over `brByPoint` and `countersByPoint`), so history is counted once under `terminal-prompt-detect`. `getCensusEntry` falls back to the alias only after an exact miss, the old id is not in `PROVENANCE_COVERAGE`, and the ratchet suite passes (58/58).
- Missing residual risk A (one-sided measurement): `blocking` can only ever grade wrong (answered prompts become input-while-unchanged, which grades unknown), and `no-prompt` can only ever grade right. So right/(right+wrong) for this point is not an accuracy rate. It measures false positives only. An incumbent false negative, like the brief's own Codex "content can't be shown" menu that got `NO_PROMPT`, ends as `unchanged-no-input` or `input-while-unchanged` and grades unknown, never wrong. The artifact should say this point's settled grades cannot detect incumbent misses.
- Missing residual risk B (race with the verdict): the incumbent verdict is set only when its promise settles (PromptGate.ts:893). If the pane changes during the LLM call, the observation closes with incumbent `unknown` and grades unknown. That throws away the fastest and most informative "not blocking" evidence. If the outcome lands before the router settles the decision row, it is also counted in `orphanOutcomes` (FeatureMetricsLedger.ts:1780) even though it joins later.
- Missing residual risk C (writers outside the guard): besides `/interrupt`, the Codex adapter's prompt `respond()` writes with raw send-keys (src/providers/adapters/openai-codex/observability/interactivePromptObserver.ts:77) and goes around the guard. On a Codex `exec` session, a prompt answered that way would read as progressed-without-input and grade a correct "blocking" verdict wrong. This is exactly the Codex-menu case that motivated the change. The artifact's "rare on PromptGate-monitored sessions" was not verified. Tmux reflow on resize or attach also changes the bottom five lines with no input.

### Author response

- B fixed in `PromptDetectOutcomeObserver` (held first event, recorded at settle); tests cover held-then-graded, failed-call and never-settled cases.
- A and C added to the under-block list above (C's adapter path verified as having no caller).
- The reviewer's failing integration run was a real defect, not timing: the served Jev context masked the correlation id, so the HTTP join could not work. Fixed by the top-level `producerCorrelationId` field; the integration test now asserts the join on the served row and passes.
