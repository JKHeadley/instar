# Side-Effects Review — Keyword-Intent Ratchet: flip to ENFORCE + resolve 3 latent offenders

**Version / slug:** `keyword-lint-enforce`
**Date:** `2026-07-04`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `fork reviewer (see below)`

## Summary of the change

Gives the "Intelligence Infers, Keywords Only Guard" ratchet (`tests/unit/keyword-intent-decision-ratchet.test.ts`) its enforcement teeth and clears the last three latent offenders. Two edits carry the weight: `ENFORCE = false → true` (the `<= BASELINE` guard is now a hard CI failure, not a warning) and `BASELINE = 4 → 1`. The three original latent offenders are resolved: `core/TopicClassifier.ts` and `core/AutonomySkill.ts` are **removed** as genuinely-dead code (verified zero runtime importers), and `core/AgentReadinessScorer.ts` is **allowlisted** as a legitimate task-nature survivor (it scores a task's coordination-vs-judgment ratio for an advisory endpoint, not message intent). Supporting edits: drop the `AutonomySkill` barrel export from `src/index.ts`, delete `tests/unit/AutonomySkill.test.ts`, surgically remove the `TopicClassifier` describe block + imports from `tests/e2e/discovery-round2-final.test.ts`, and drop the two deleted class names from the `under-the-hood.md` class list. Docs (`spec` + `eli16`) extended to record the flip. The only decision-point surface here is a CI-time lint ratchet; there is no runtime message-path behavior change.

## Decision-point inventory

- `keyword-intent-decision-ratchet` CI ratchet — **modify** — flips from report-mode (warn) to enforcing (fail CI on net-new offender); baseline lowered 4→1.
- `TopicClassifier.scoreKeywords` (runtime) — **remove** — dead-code keyword classifier, no runtime callers; deleted.
- `AutonomySkill.INTENT_PATTERNS` (runtime) — **remove** — unwired keyword intent recognizer; deleted.
- `AgentReadinessScorer.scoreText` (runtime) — **pass-through** — unchanged; only its ratchet classification moves (offender → allowlisted survivor).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only "block" surface is CI. Over-block here = the ratchet failing a PR that is not actually a keyword-intent offender (a false positive). This is the risk the enforcement flip introduces. It is mitigated structurally: the detector is deliberately tuned to under-report (errs toward false negatives), the audit's cleared classes are explicitly allowlisted, and the change ran a full soak cycle in report mode (merged 2026-07-03, many PRs since) with zero false positives. Verified on this branch: the ratchet flags exactly one file (`topicProfileIngress`), matching `BASELINE = 1`. There is no runtime/message over-block surface — this never rejects a user message.

---

## 2. Under-block

**What failure modes does this still miss?**

The detector's two regex signatures can miss a subtly-shaped keyword-intent gate (e.g. a list assembled at runtime, or a message-var name outside the recognized set). This is the intended conservatism (a noisy ratchet gets disabled). A NEW offender added *inside* an allowlisted file is also masked — including, now, `AgentReadinessScorer.ts`: a future keyword-intent message gate added to that file would not be caught. This is the documented, accepted cost of every allowlist entry. The removal of the two dead modules strictly shrinks the under-block surface (two fewer places a keyword classifier could be silently re-wired).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The ratchet is a build-time lint (a low-cost structural guard), sibling to `no-silent-fallbacks`, enforcing a constitutional standard at the exact layer that standard is meant to bite — before merge, in CI, per-file. It is not a runtime authority over messages (that would be the wrong layer for a keyword-shaped detector). The flip to enforce is the planned graduated-rollout step the original spec's Rollout section already specified. The dead-code removals are at the correct layer too: deleting an unused module is the right resolution for a latent offender that nothing wires — converting it to LLM-with-context would be dead work on dead code.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] Yes — but the logic is appropriate for its layer: a CI-time ratchet whose "authority" is failing a build on a per-file structural count, with a human-authored allowlist + explicit baseline doing the precision work. It holds no runtime authority over any message.

The ratchet is a deterministic structural check, not a runtime gate over conversational content. Its "block" is a red CI check that a human (or the agent) resolves by converting the offender to LLM-with-context or justifying it as a survivor — exactly the graduated no-silent-fallbacks pattern. It never sits in the message path. Brittle-logic-with-runtime-block-authority (the anti-pattern this question guards) does not apply.

---

## 5. Interactions

- **Shadowing:** none. The ratchet is a standalone vitest file; it does not run before/after another check in any pipeline. Removing the two modules cannot shadow anything — nothing imported them.
- **Double-fire:** none. Single test file, single assertion path.
- **Races:** none. No shared mutable state; the detector reads source files at test time.
- **Feedback loops:** none.
- **Test-file interaction:** `tests/e2e/discovery-round2-final.test.ts` imported `TopicClassifier`; its describe block was surgically removed and the remaining three blocks (which test `FeatureRegistry`, not `TopicClassifier`) verified green (12 tests pass). `tests/unit/AutonomySkill.test.ts` was the only consumer of `AutonomySkill` and was deleted with it.

---

## 6. External surfaces

- Other agents / install base: no runtime change — this is a test + dead-code removal. Removing the `AutonomySkill` barrel export from `src/index.ts` is technically a public-API narrowing, but instar is consumed as a CLI/server, not as a library whose consumers import `AutonomySkill`; the audit itself classified it "exported, unwired". No known consumer.
- External systems (Telegram/Slack/GitHub/Cloudflare): none.
- Persistent state: none — no ledgers, DBs, or memory files touched.
- Timing/runtime: none.
- **Operator surface:** no operator-facing actions added or touched — not applicable.

---

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches only a test, two deleted `src/core` modules, a barrel export, and docs; no dashboard renderer, approval page, or grant/secret form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — with the reason: this is a build-time CI lint plus source-tree deletions. It has no runtime state, emits no user-facing notices, holds no durable state that could strand on topic transfer, and generates no URLs. The ratchet runs identically in every checkout because it reads the committed source tree; there is nothing to replicate or proxy. A multi-machine agent sees byte-identical behavior on every machine.

---

## 8. Rollback cost

**Pure code + test change — revert and ship a patch.** No persistent state, no data migration, no agent-state repair, no user-visible regression during the rollback window. The narrow rollback lever for just the enforcement teeth is a one-line flip (`ENFORCE = true → false`) back to report mode. Restoring the two deleted modules, if ever genuinely wanted, is a `git revert` — their full source lives in history. `BASELINE` and `EXPECTED_OFFENDERS` are kept internally consistent, so a revert is mechanical.

---

## Conclusion

The review produced no design changes. The change is proportionate: it flips a lint to enforcing after a clean soak (the planned rollout step) and resolves the three latent offenders the correct way per offender — delete the two verified-dead keyword classifiers, allowlist the one genuine task-nature survivor. The only genuine risk (a CI false positive from the enforcement flip) is mitigated by the soak, the conservatism-first detector, and the allowlist, and is confirmed absent on this branch (offenders == baseline == 1). tsc, lint, the ratchet suite, and the affected e2e all green. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Phase 5 — change touches a "guard"/"gate")
**Independent read of the artifact: concur**

Concur with the review. Independently verified: the diff matches the artifact (deletions of `AutonomySkill.ts`/`TopicClassifier.ts`/their tests, ratchet `ENFORCE false→true` + `BASELINE 4→1`, `EXPECTED_OFFENDERS == ['core/topicProfileIngress.ts']`, `AgentReadinessScorer` moved to ALLOWLIST); the two removed modules are truly dead (grep across `src/` → only a comment reference, zero runtime consumers); `AgentReadinessScorer` is genuinely wired at `src/server/routes.ts` for the `/agent-readiness` endpoint and scores task-nature (`COORDINATION_SIGNALS`/`JUDGMENT_SIGNALS` density → `coordinationRatio`), not message intent — the allowlist justification is accurate; `tsc --noEmit` exit 0; `vitest` 17 passed (ratchet in ENFORCE, baseline 1); the ratchet's internal guards remain coherent.

---

## Evidence pointers

- `npx vitest run tests/unit/keyword-intent-decision-ratchet.test.ts tests/e2e/discovery-round2-final.test.ts` → 17 passed; ratchet prints `[KEYWORD-INTENT] 1 keyword-list intent decisions (baseline 1, mode=ENFORCE)`.
- `npx tsc --noEmit` → exit 0 (no lingering references to removed symbols).
- `npm run lint` → exit 0.
- Wiring verification: `grep` across `src/` for static imports, dynamic `import()`, `new X`, and function-name imports of `TopicClassifier`/`AutonomySkill`/`classifyForDiscovery` → zero runtime consumers.
