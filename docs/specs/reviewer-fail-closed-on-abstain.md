---
title: "Coherence Reviewers Fail CLOSED on Abstain (CMT-1794 fail-open fix)"
slug: "reviewer-fail-closed-on-abstain"
author: "echo"
status: "draft"
parent-principle: "No Silent Degradation"
eli16-overview: "reviewer-fail-closed-on-abstain.eli16.md"
tracked-followups: ""
review-convergence: "2026-06-25T08:52:11.783Z"
review-iterations: 3
review-completed-at: "2026-06-25T08:52:11.783Z"
review-report: "docs/specs/reports/reviewer-fail-closed-on-abstain-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (under Justin's standing 24h autonomous blanket pre-approval, topic 28130, 2026-06-24 21:05 PDT — 'you have my preapproval for any decisions needed; don't wait on me')"
approved-basis: "standing-authorization — recorded transparently, not silently self-granted; convergence ran full 2-round multi-reviewer + codex cross-model + conformance gate; operator may revert by editing this frontmatter"
---

## Problem

The CMT-1794 convergent audit (2026-06-25) found the "An LLM Gate Must Not String-Match" standard fully satisfied (zero violations) and ONE systemic fail-open violation of **No Silent Degradation**:

`CoherenceReviewer.review()` (base) catches every non-capacity error and resolves with the PERMISSIVE verdict `{ pass: true, severity: 'warn' }` (the generic catch ~L201-210); `parseResponse()` returns the same `failOpen` on unparseable/malformed output (~L251). The capacity-shed path is correctly tagged `{ pass:false, capacityUnavailable:true }`.

The narrow, real bug (round-1 convergence confirmed it): `CoherenceGate` increments `abstainCount` ONLY when a reviewer promise REJECTS (~L415-425). Because `review()` catches internally and RESOLVES with `pass:true`, an errored/timed-out/unparseable reviewer is recorded as a **genuine PASS** — it never reaches the abstain branch, so the gate's EXISTING high-criticality fail-closed net (`HIGH_CRIT_TIMEOUT`) never engages. Net: on an LLM blip, the highest-stakes outbound checks (credential/PII leakage, org-constraint violations, fabricated claims, hallucinated URLs) silently pass.

Two smaller sibling fail-opens: `MessageSentinel` non-capacity catch + unparseable (ambiguous-message band; mitigated because the deterministic emergency-stop fast-path runs first), and `SendGateway` Stage-4 try/catch around `coherenceGate.evaluate()` (~L253) which swallows a thrown gate error and SENDS on external channels.

## What already exists (round-1 foundation audit — load-bearing)

The gate ALREADY has the criticality machinery this fix needs; the initial draft wrongly proposed a parallel one. Reuse, do not reinvent (Signal-vs-Authority: no new brittle layer):

- `reviewerCriticality?: Record<string,'critical'|'high'|'medium'|'low'>` published config (`types.ts:4040`).
- `resolveCriticality(reviewer)` (`CoherenceGate.ts:757`) → config override → org-intent auto-promote (`value-alignment`→`'high'`) → `'standard'`.
- `HIGH_STAKES_REVIEWERS` set (`CoherenceGate.ts:142-147`) = `{value-alignment, claim-provenance, capability-accuracy, information-leakage}`, used for the rate-limit-wait path.
- The `highCritTimeout` path: a `'high'`-criticality reviewer that abstains, on an EXTERNAL channel, yields `HIGH_CRIT_TIMEOUT` → **external blocks (queue/fail-closed), internal fails open** (`CoherenceGate.ts:421-424, 490, 557-590`). This is EXACTLY the channel policy the fix wants — it just never fires today because abstains are mis-tallied as passes.

## What this adds

### 1. Abstain tagging (mechanical core — uncontested)
Add `abstained?: boolean` to `ReviewResult`. The base `review()` generic catch (~L201-210) and `parseResponse()` failOpen (~L251) set `abstained: true` (keep `pass:true` as an inert placeholder — never trusted when `abstained` is set). The flag is HOST-set (in trusted catch/parse code), never model-set, so message content cannot forge it (injection-proof).

### 2. Route abstains into the EXISTING criticality machinery (the fix, corrected)
In `CoherenceGate`'s `result.status === 'fulfilled'` branch (~L415-417): if `result.value.abstained`, do NOT push it into `settled`; instead increment `abstainCount` and run `resolveCriticality(reviewer)` → if the tier is fail-closing AND `isExternal`, set `highCritTimeout = true` (the existing branch). Precedence (explicit tri-state): `capacityUnavailable` (existing block) > `abstained` (count as abstain, exclude from pass/block tallies AND from `passCount` health metrics, consult criticality) > genuine pass/block. `majorityAbstain` denominator stays `enabledReviewers.length`; `allAbstain` stays `settled.length===0 && abstainCount>0`.

**Reuse the `'high'` tier — do NOT mint a new `critical` tier** (round-1 BLOCKER: a `critical` value exists in config but NOTHING in the gate reads it; `highCritTimeout` keys on `'high'`). Unify the vocabulary: collapse the spec's "critical" language onto the existing `'high'` tier. Reconcile the high-stakes membership in ONE place (see Frontloaded Decision A).

### 3. The disposition is HOLD-and-escalate, NOT re-draft-loop (round-1 BLOCKER — "rides retry" was false)
The response-review.js Stop-hook path returns a `pass:false` to the LIVE agent for re-draft (no durable queue); naively failing closed there costs `maxRetries+1` agent turns × N reviewer spawns DURING the outage — retry/spawn amplification adjacent to the fork-bomb the capacity path prevents. So: a `'high'`-abstain block whose cause is an LLM-availability signature (provider error / timeout / capacity, NOT a content verdict) **short-circuits to `hold` (operator-escalate once), bypassing the per-turn re-draft loop** — it does NOT consume `maxRetries` by re-drafting against a down provider. A per-(reviewer, window) **breaker** (mirroring P19) trips after K abstains so a persistently-erroring critical reviewer holds-and-escalates-once rather than re-spawning forever.

**Hold state machine (codex round-2 finding — define it explicitly, don't leave as intent):** a held draft is a small state `held → {released | discarded | expired}` keyed by `(topicId, contentHash)` for dedupe; carries a retry budget (Decision E) and a TTL after which it `expired`s with one operator notice; `released` on the next successful review, `discarded` on an explicit operator action or topic-stop. Machine-local (Decision E).

**Outage-vs-content classification is STRUCTURED, never string-matched (codex round-2 finding — the very standard this work enforces, applied to itself).** The abstain cause is taken from STRUCTURED error classes surfaced by `IntelligenceProvider` / the parse path — `capacityUnavailable` (typed), provider-transport-error (typed), timeout (typed), unparseable-output (parse path) — NOT by substring-matching a provider error message. Content-induced abstain (a crafted message that reliably errors/over-runs a reviewer → route to operator, do not infinitely retry the same poisoned draft) vs backend-down abstain (transient → bounded one retry then hold) is decided from those typed classes. **Any UNKNOWN/unclassified error → the conservative HOLD path** (fail-closed is the safe default for an unrecognized failure).

### 4. Kill-switch (round-1 MATERIAL — the referenced one is the tone-gate's, not this gate's)
New `responseReview.failClosedOnCriticalAbstain` (default `true`), read LIVE per-evaluation in `_evaluate` so a flip needs no restart (mirrors `messaging.toneGate.failClosedOnExhaustion`). `migrateConfig` adds it with an existence check (default true). When false, a critical abstain reverts to the prior fail-open (reported).

### 5. The critical set is a FLOOR, hardcoded-default (round-1 MATERIAL — config-downgrade vector + multi-machine)
The high-stakes/critical set is a HARDCODED default in source (uniform across machines by construction — the multi-machine-safe choice). `reviewerCriticality` config may RAISE a reviewer's tier but may NOT lower a floor member below the fail-closing tier on external channels (a security control must not be silently downgradable). A lowering attempt is clamped + reported (DegradationReporter / guard-posture). Resolve the published-type mismatch: `'standard'` is added to the `reviewerCriticality` union (or the resolver stops emitting it) so config + resolver agree.

### 6. Close the two coverage bypasses the fix would otherwise leave open (round-1 MATERIAL)
- **recipientType bypass:** `information-leakage` is hard-skipped when `recipientType==='primary-user'` (`CoherenceGate.ts:719`), which is the DEFAULT — so the headline protection can't fire on the common path. Fail-closed/criticality MUST key on the RESOLVED external flag (`isExternalFacing ?? isExternalChannel`), never a downward-launderable `recipientType` label. Frontloaded Decision B settles whether leak-review stays enabled for primary-user on external channels.
- **<50-char SendGateway gate:** `shouldRunLLM` only runs the gate when `message.length>50 || containsUrl` (`SendGateway.ts:218-223`), so a short URL-free external message (a bare token / short PII) skips leak review entirely. Frontloaded Decision C settles whether short external messages route through leak review.

### 7. SendGateway Stage-4 + MessageSentinel (siblings)
- SendGateway Stage-4 catch: classify channel as the gate does (`isExternalFacing ?? isExternalChannel`); on external, fail to the SAME held/queued disposition as the gate's external branch (reported), NOT a silent send and NOT a hard drop. Bound it so a non-capacity gate CRASH escalates once rather than wedging all outbound.
- MessageSentinel: non-capacity catch + unparseable → hold/pause for the ambiguous band (the deterministic emergency-stop fast-path runs first, so a genuine "stop" is never lost). This stays a fail-closed abstain fed to the same authority, NOT a new independent block path (Signal-vs-Authority).

### 8. failureSwap engagement — REQUIREMENT, not "confirm" (round-1 + codex round-2)
All reviewer LLM calls MUST set `gating:true` so the router's `failureSwap` tries another harness/account BEFORE the reviewer abstains — a single-provider blip swaps (review stays alive) and fail-closed engages only on a true multi-provider outage (the No-Silent-Degradation canonical pattern). A ratchet test (§9) asserts a single-provider failure SWAPS and never reaches the abstain return; abstain engages only when the swap chain is exhausted. (Not left as implementation discovery — it is the difference between "held during any single blip" and "held only during a true outage".)

### 9. CI ratchet (durability)
A unit test driving EVERY registered reviewer subclass (incl. DynamicReviewer / custom-loaded) through a forced error + a malformed-parse input, asserting `abstained:true` (never a bare permissive verdict); assert no subclass overrides `review()` (the tagging chokepoint) without re-applying the tag; assert each floor reviewer resolves to a tier the gate fails closed on externally. Add to the `no-silent-llm-fallback` ratchet family + STANDARDS-REGISTRY "No Silent Degradation".

## Frontloaded Decisions

**A — Critical/high-stakes membership (reuse `'high'`, hardcoded floor).** The fail-closing floor set = `{information-leakage, value-alignment, claim-provenance, url-validity}` (hallucinated URLs are an external-facing leak), reconciled into ONE source of truth with `HIGH_STAKES_REVIEWERS`; `capability-accuracy` is DEMOTED to standard (an over-claim is a correctness warn, not a leak). Config may raise, never lower a floor member externally. Rationale: reuse the existing tier (no parallel taxonomy), hardcoded default = multi-machine-uniform, floor = no silent downgrade.
- **Predicate-normalization (round-2 finding):** the gate's fail-closing trigger is currently an EXACT `criticality === 'high'` (`CoherenceGate.ts:422`), but `reviewerCriticality` config accepts `'critical'` as a valid union value — a config-set `'critical'` reviewer would NOT trip the existing predicate and would fall through to a silent pass (the exact dead-value class round 1 flagged). FIX: `resolveCriticality` NORMALIZES `'critical' → 'high'` at its return (so the gate only ever sees `'high'` for the fail-closing tier), OR the predicate treats `criticality === 'high' || criticality === 'critical'` as fail-closing. The §9 ratchet MUST exercise a config-set `'critical'` reviewer and assert it fails closed externally, locking this in.

**B — recipientType / external resolution.** Criticality + fail-closed key on the RESOLVED external flag, not the caller-supplied `recipientType` (which cannot launder an external send as internal). `information-leakage` stays ENABLED for `primary-user` on EXTERNAL channels (a message to the operator can still leak a THIRD party's PII); it remains skipped only for genuinely internal/self channels.

**C — Short-message coverage.** On EXTERNAL channels, the gate runs the critical reviewers regardless of the `>50||url` length gate (a short token/PII is the exact threat); the length gate stays only for internal/low-stakes. **Cost/latency bound (codex round-2):** ONLY the critical floor reviewers run on the short-message path (not the full panel), they run with the existing reviewer concurrency cap, and a new `/metrics/features` counter (short-external-critical-review calls) is watched after rollout so a latency/cost cliff on a high volume of short external acks is visible and tunable. Clearly-non-sensitive boilerplate is NOT special-cased (no allowlist bypass — that would reintroduce a string-match gate); the cost is bounded by the floor-only subset instead.

**D — Internal-channel policy.** A critical abstain on an INTERNAL channel stays pass-with-report (fail-open, audited), matching the existing `HIGH_CRIT_TIMEOUT`/`ALL_ABSTAIN` internal policy — blocking internal outbound on a blip risks wedging the agent's own control loop; internal leak risk is materially lower. Reported via DegradationReporter; tracked-followup to revisit if internal leak incidents appear.

**E — Disposition on the re-draft path.** A `'high'`-abstain block on an availability signature short-circuits to `hold` (operator-escalate once), bypassing the maxRetries re-draft loop, with a per-(reviewer,window) breaker. Held drafts are machine-local (not durable across topic transfer) — stated honestly; a mid-hold topic transfer drops the held draft (the agent re-drafts on the new machine), acceptable because the alternative (durable cross-machine held-draft queue) is out of scope.

## Multi-machine posture

The fix is **replicated/uniform by construction**: the floor set + abstain logic + breaker are compiled from source (identical across machines); `reviewerCriticality` config is machine-local-by-design but can only RAISE criticality, and the hardcoded floor holds on every machine regardless of config presence, so the leak/constraint protection cannot silently diverge. Held drafts are machine-local (Decision E). No user-facing notice (operator escalations ride the existing attention/DegradationReporter surface, already one-voice-gated).

## Non-Goals

- Not changing the deterministic safety floors (dangerous-command-guard etc.).
- Not changing the intentional, documented fail-opens: CoherenceGate internal-channel ALL_ABSTAIN policy (Decision D keeps it), InputGuard warn-only, standards-conformance / crossModelReviewer signal-only.
- Not building a durable cross-machine held-draft queue (Decision E).

## Open questions

*(none)*
