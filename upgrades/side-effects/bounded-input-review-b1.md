# Side-Effects Review — bounded-input derivation review, batch 1 (src/core)

**Version / slug:** `bounded-input-review-b1`
**Date:** `2026-11-18`
**Author:** `Echo (M5)`
**Second-pass reviewer:** `independent reviewer subagent (concur, round 2)`

## Summary of the change

First of four batches clearing `STD-SUBCOUNTDOWN-bounded-input-derivation-review` (the lint fails every run from 2026-11-23 00:00 UTC). Ten baselined sites in `src/core` were each read against what their consumer does with the value; the baseline shrinks 43 → 33 and its ceiling with it. Tier 1: nine files of source, a revert undoes all of it, no stored state changes shape. Per-site readings are in `docs/audits/bounded-input-review/batch-1.md`.

Five sites change behaviour:
- `GeminiCliIntelligenceProvider.ts`: the capacity decision (retry / switch model / defer) now reads the FULL stderr instead of its first 600 characters, matching the transport adapter's twin. The thrown error message keeps 600 characters of stderr content plus a `boundedHead` disclosure.
- `standing-authorization.ts` + `MessagingToneGate.ts` (`quote`): the operator-grant quote B17 judges is bounded once, at its source, by `STANDING_GRANT_QUOTE_CHARS` (4096 + disclosure room) instead of 280 twice, so the grant phrase that matched is no longer cut out.
- `MessagingToneGate.ts` (`truncated`): recent-conversation context keeps the same ~500 characters per message, but the cut is disclosed in-band instead of a bare "…".
- `JobReflector.ts`: recorded commands in the reflection prompt use `boundedHead` with `JOB_STEP_COMMAND_CHARS` (100 + disclosure room), so commands up to ~335 characters appear whole and longer ones say they are cut.
- `PostUpdateMigrator.ts` (action-claim Stop hook): a reply over 24,384 characters is sent to `/action-claim/observe` as its first 16,384 characters (byte-identical, see §5) + a disclosure + its last 8,000, instead of only the first 16,384. Replies up to 24,384 now go whole. Lane A (`classifyActionClaim`) now sees a closing promise in a long reply; Lane B and the stored record still read `message.slice(0, 500)` on the route, unchanged by this batch.
- `AutoDispatcher.ts`: the approval message's footer now offers the full text of a cut preview (exemption reason on the preview line).

Five sites are exempt with a written `bounded-input-reviewed:` reason (operator-facing preview, stored records, a string splice, model output held to its own prompt's limit).

## Decision-point inventory

- Gemini capacity policy (`decideGeminiCapacityPolicy` caller) — modify input — now sees the whole stderr.
- Tone gate B17 standing-authorization sub-clause — modify input — sees the whole grant (Telegram) or a disclosed head.
- Tone gate RECENT CONVERSATION context — modify input — same content, disclosed cut.
- Job reflection prompt — modify input — longer commands whole, cut disclosed.
- Action-claim classifiers (server side, unchanged) — modify input from the hook — head+tail instead of head.

No decision logic is added or changed; only what the existing deciders are shown. That is still a behaviour change for Gemini: `isGeminiCapacityError` matches `quota` / `usage limit` / `capacity` anywhere in its input, so a non-capacity failure whose long stderr mentions one of those words past character 600 now retries or defers instead of failing fast. That is the same behaviour the transport adapter already has.

---

## 1. Over-block

No new block anywhere. The B17 sub-clause can now see a covering grant it used to miss, so it can fire on an ask it used to let through; B17's own UNDER-FIRE rule (fire only when the grant plausibly covers THIS action) still governs, and that is the intended behaviour the sub-clause was specified to have.

## 2. Under-block

The Gemini catch path (spawn error, not a non-zero exit) still hands the circuit breaker a bounded message, not the full stderr; it is now disclosed rather than silent. A promise in the dropped middle of a >24KB reply is still missed. Lane B (time promises) and the stored record on the action-claim route read only the first 500 characters of the message; that bound lives in `src/server/routes.ts` and is reviewed with the routes batch, not here.

## 3. Level-of-abstraction fit

Each bound now lives where the cut happens. The grant quote moved its bound to the resolver (the one producer) instead of being re-cut in the gate. The hook cannot import TypeScript, so it carries the disclosure inline in the helper's wording, with a reviewed note naming why.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). No check gains or loses authority. The tone gate keeps its existing authority; only its evidence is more complete. The action-claim path stays signal-only (the hook always exits 0).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The bounds are size budgets with their derivations written beside them.

## 5. Interactions

- Gemini: `recordGeminiCapacityDeferral` still receives `capacity.reason ?? message` (the bounded message), unchanged. `isGeminiCapacityError` and `parseGeminiRetryAfterMs` now scan the message AND the full stderr; both are regex scans over text already in memory.
- Tone gate prompt: grows by at most ~3.8k characters when a verified grant is present (dev-gated path), and by at most six disclosure markers (~1.4k) for long context messages. Well under `TONE_CANDIDATE_BODY_MAX_CHARS`-scale prompt sizes the gate already handles.
- Action-claim route: code unchanged. It dedups against the completion-claim path with `getRecentAuthoritativeArbitration(message)`, which fingerprints `scrubSecrets(message).slice(0, 16_384)` (`CompletionClaimVerifier.messageFingerprint`), while the completion-claim hook sends the whole reply. The hook keeps that prefix byte-identical so the two fingerprints still match; a test asserts the prefix. (The second-pass review caught that a first version, head 8000 + tail 8000, broke this dedup for long replies.) It still takes `message.slice(0, 500)` for the stored record and Lane B.
- Stage-B certified set: `MessagingToneGate.ts` (already excluded) now imports `boundedInput.ts` and `standing-authorization.ts`, so both joined the canaried import closure and the pre-push fingerprint check refused them as unclassified. Both are added to `src/data/stageBCertifiedSet.ts` `excluded` with reasons (pure helpers, no delivery logic, own unit suites). The certified fingerprint is unchanged. Open PR #3326 also edits that file; the two edits are separate array entries.
- Gemini: see the decision-point note: wider capacity matching on long stderr, matching the adapter twin.
- Job reflection: each cut command is ~70% disclosure (103 chars kept + ~230 marker), so a job with many very long commands grows its prompt up to ~3x. Accepted: the steps are evidence, and the prompt was already unbounded in step count.

## 6. External surfaces

No route, config key, or user-visible text changes. The action-claim hook file is rewritten on update by the existing always-overwrite path for built-in hooks (Migration Parity: no new migration needed). Gemini error messages read by people are now longer by up to ~235 characters when stderr was cut.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: every change is a pure in-process transformation of a value on the machine that makes the decision. Nothing is stored, replicated, or proxied.

## 8. Rollback cost

Revert the PR. No data, config, or state migration; the hook is rewritten back on the next update.

## Conclusion

Ten sites cleared: five converted with derived bounds, five exempted with reasons. Three of the conversions fix real defects found by the reading (Gemini deciding from a truncated stderr, B17 judging a grant with its phrase cut out, the action-claim hook keeping only the start of long replies). The second pass changed the design once (dedup prefix parity) and corrected three overstatements in this artifact; all addressed.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5, fresh context, read-only), two rounds
**Independent read of the artifact: concur**

Round 1 raised CONCERN: (1) the first hook version (head 8000 + tail 8000) changed the 16,384-char prefix that `CompletionClaimVerifier.messageFingerprint` keys the action-claim / completion-claim dedup on, so long replies could register duplicate commitments; (2) the closing-promise claim overstated coverage (Lane B and the stored record read the route's own 500-char head); (3) §5 omitted the fingerprint interaction and the wider Gemini capacity matching; (4) the batch readings file was untracked; (5) the AutoDispatcher exemption claimed a full-text option the message did not offer; (6) JobReflector prompt growth unstated. All six were fixed (prefix kept byte-identical with a test, claims narrowed, §5 completed, footer now offers full text, growth accepted in §5). Round 2: CONCUR — the dedup break is closed and the artifact is accurate. Residual noted, pre-existing: `scrubSecrets` shortening a secret inside the prefix can still make the two fingerprints differ, exactly as with the old cut.

---

## Evidence pointers

- `tests/unit/bounded-input-review-batch1.test.ts` (Gemini retry on late capacity line; grant phrase past 280; disclosed long grant). All three fail on the old code (verified by reverting the two source lines) and pass on the new.
- `tests/unit/JobReflector.test.ts` (new case: medium command whole, long one disclosed).
- `tests/unit/action-claim-hook-slack.test.ts` (runs the emitted clamp: keeps the closing promise, discloses the middle).
- `tests/unit/MessagingToneGate.test.ts` (context cut now disclosed).
- `node scripts/lint-bounded-judgment-input.mjs` → clean, 33 grandfathered.

---

## Class-Closure Declaration (display-only mirror)

Class closure for this change: the defects fixed are instances of silently cut judgment input, which is governed by its own standing guard, `scripts/lint-bounded-judgment-input.mjs` (shrink-only baseline with a ceiling). That lint refuses any NEW bare truncation feeding a prompt; this batch shrinks the population it already holds. No registry class in `docs/defect-classes.json` names this shape; see the decision-audit entry for the declaration the gate records.
