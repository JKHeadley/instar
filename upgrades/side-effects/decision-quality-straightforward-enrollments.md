# Side-effects review — straightforward decision-quality enrollments

**Slug:** `decision-quality-straightforward-enrollments`

**Spec:** `docs/specs/llm-decision-quality-meter.md`
**Scope:** enroll the 28 census rows classified as router-backed and mechanical by the converged current-state audit. The nine repair-first and ten blocked/stale rows remain pending.

## Summary

The change moves 28 existing model judgments from `pending` to `wired` under the shipped decision-quality meter. Each enrollment has a typed decision-point constant, a stable prompt identity, code-authored options, an explicit bounded daily volume budget, and an identity-only context builder. The model call, deterministic floor, fallback, and enacted behavior are unchanged. Where no independent grading rule exists, the row is explicitly measurement-only rather than implying outcome knowledge.

The census row count remains 81 while the model-judgment subset moves from 11 wired / 47 pending / 6 exempt to 39 wired / 19 pending / 6 exempt. This is conversion of declared debt, not denominator expansion.

## Decision-point inventory

The batch touches existing classifiers, sentinels, summarizers, evaluators, reviewers, and resume/session judgments. It adds observation metadata at their existing router calls. It does not add a new judge, change any verdict vocabulary, or grant any model result new authority.

## 1. Over-block

None identified. Provenance construction is observational and does not participate in the production verdict. Existing throws, parse failures, deterministic fallbacks, and fail-open/fail-closed behavior retain their prior owners. A provenance write failure remains evidence loss, not a reason to block the underlying action.

The forward safety ratchet identified three newly visible advisory callsites whose existing benign fallback was not explicitly classified. `PreCompactionFlush` records a provider error and writes no facts, `Usher` emits its degradation callback and returns no reactivation, and Mentor Stage-B forensics treats the failed signal-only read as a no-op tick. Each now carries the ratchet's reviewed `@llm-fallback-ok` marker with its concrete fail-safe direction. None is marked `gating: true`, so provider-routing and enacted behavior remain unchanged.

## 2. Under-block and residual gaps

This batch does not close universal coverage. Nine declared rows still require identity/composition repair and ten remain blocked, dark, or stale. It also does not create decision-to-outcome joins for these new measurement-only points, add screenshots, or make rich capture lossless. Those omissions remain visible in the census and the separate full-decision-visibility audit; none is relabeled as complete.

## 3. Level-of-abstraction fit

The existing `IntelligenceRouter.evaluate` provenance seam is the correct layer: it observes the exact model-backed judgment without creating parallel stores or component-specific logging engines. Shared builders centralize bounded identity construction; component code supplies only stable, code-authored decision identity and shape.

## 4. Signal vs authority

Compliant with `docs/signal-vs-authority.md`. Every addition is a signal to the existing quality meter. No brittle detector acquires block, allow, retry, route, resume, stop, or messaging authority. Measurement-only posture is explicit when later evidence cannot truthfully grade the judgment.

## 5. Interactions and races

The change reuses the existing provenance recorder, volume valves, grading posture, and census ratchet. It adds no second observer with competing write authority. Prompt/options construction moved into dedicated helpers only where needed to make the provenance envelope testable; production prompts and evaluation settings remain equivalent. The recorder remains downstream of the existing router lifecycle, so no new ordering race is introduced.

## 6. External, security, and privacy surfaces

No external API, provider, message, notification, URL, or operator action is added. The model already received the underlying prompt before this change. New durable context contains structured SHA-256 identities and bounded counts/booleans only: no message body, transcript, query, source fragment, terminal output, session name, or prompt slice is copied into provenance. Static `optionsPresented` values are code-authored and contain no user data.

The PR touches messaging adapters because two existing stall confirmations are enrolled, but it changes no user-visible wording, timing, delivery, or decision. Prompt IDs such as `telegram-stall-confirm-v1` are internal metadata only.

## 7. Multi-machine posture

Machine-local by design, using the meter's existing posture. A judgment is recorded on the machine that executed it; the batch adds no topic-bound durable state, lease, ownership transfer, cross-machine write, or one-voice notification. Existing pool read behavior is unchanged. Because this is observation-only, a decision made during machine handoff preserves the same enacted behavior even if its local provenance write is unavailable; the missing evidence remains an observability defect rather than split authority.

## 8. Cost, storage, and throughput

All 28 new rows are budgeted rather than `full`, using the existing 100 / 250 / 500 daily volume classes according to observed call volume. The new context is small and identity-only. There is no additional model call. Worst-case storage is bounded by the existing per-point daily valves and retention policy; grading throughput does not increase because the rows remain measurement-only until independent evidence rules exist.

## 9. Compatibility and migration

No schema, database, configuration, scaffold, environment variable, network protocol, or migration changes. Runtime consumers that do not enable the shipped provenance seam behave as before. The typed census remains shrink-only and the total row count does not change.

## 10. Rollback

Each enrollment batch is isolated in a small commit. Reverting the relevant commit removes only the added provenance metadata and restores the corresponding census rows to pending; it does not require data repair and does not alter domain state. Already-recorded bounded evidence can age out under the existing retention path.

## Verification

- 850 tests across 29 files passed with all 28 enrollments combined.
- TypeScript no-emit checking passed.
- The LLM-attribution, no-direct-LLM-HTTP, and no-whole-file synchronous-read guards passed.
- The no-silent-LLM-fallback ratchet passes with all three newly visible advisory callsites explicitly classified.
- The census ratchet proves 81 rows before and after, with wired increasing from 11 to 39 and every added row carrying grading posture, reason, and a non-full budget.
- Echo independently reviewed PR #1841 against pre-written bars and approved head `0c34ae9bc`, specifically confirming genuine wiring and conversion without denominator inflation.

## Second-pass review

The prior adversarial, security, and scalability passes found no authority expansion, plaintext capture, unbounded volume, external egress, schema/config migration, or multi-machine behavior change. Echo's independent PR review concurred on the load-bearing wiring and denominator bars. No unresolved side-effect concern remains for the enrollment batch.

Concur with the review — the three safety markers accurately describe the pre-existing benign fallbacks: audit-and-no-write, degradation-and-no-reactivation, and signal-only empty findings. None gates or authorizes action, and the patch changes only comments/documentation with no runtime, security, or privacy behavior change.
