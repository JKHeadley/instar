# Side-Effects Review — Bounded mentor-onboarding retries

**Version / slug:** `bounded-mentor-onboarding-retries`
**Date:** `2026-07-27`
**Author:** `Instar Agent (instar-codey)`
**Review tier:** Tier 1, user-directed

## Summary of the change

`OutstandingPromptTracker` extends its existing durable correlation ledger with a content-keyed retry ledger. Live mentor delivery reserves an attempt before transport, permits at most three attempts for the same unanswered normalized content, keeps new content independent, and persists a one-shot exhaustion escalation. `runMentorTick` now awaits the delivery callback and exposes the delivery layer's structured reason.

The tracker persists only SHA-256 content keys plus mentee, attempt, timestamp, and escalation metadata. The ledger holds at most 64 unresolved content keys. Existing version-1 files load and upgrade on the next write.

## Decision-point inventory

- `OutstandingPromptTracker.reserveSend` — **new authority inside an existing authority** — permits or refuses one mentor send based on in-flight state, content-key attempts, storage availability, and the fixed ledger capacity.
- `OutstandingPromptTracker.clearByCorr` — **modified** — a correlated reply now closes both the outstanding correlation and that content's retry episode.
- `OutstandingPromptTracker.markDeliveryFailed` — **new transition** — removes the in-flight correlation while retaining the consumed attempt.
- `AgentServer.deliverToMentee` — **modified actuation boundary** — durably reserves before transport and returns a structured delivery outcome.
- `runMentorTick` — **modified observer** — awaits the delivery boundary and records its reason; it does not decide the retry policy.
- `DegradationReporter.report` — **existing signal path** — emits one delivery-exhaustion event after the durable latch admits it.

---

## 1. Over-block

The brake can suppress a prompt whose wording is identical even if the mentor intended a semantically separate repetition. That only happens after three sends without a correlated reply. A confirmed reply deletes the content episode, so later reuse after a real conversation is allowed. A genuinely different agenda item hashes separately and remains eligible.

Whitespace is normalized before hashing. Cosmetic spacing cannot evade the brake, but punctuation or wording changes produce a new key. This is deliberate: the gate refuses exact normalized repetition, not semantic similarity judged by a brittle classifier.

The 64-key ledger cap can refuse a novel prompt after 64 unresolved content episodes. That is a fail-closed capacity bound. It prefers pausing the autonomous mentor over allowing either unbounded state growth or eviction that would silently reopen old breakers.

---

## 2. Under-block

An LLM can paraphrase the same intent and receive a new content key. This patch closes the observed identical-content loop, not semantic-repetition detection. Semantic dedupe would require judgment and risks suppressing legitimately revised questions; it is intentionally outside this Tier 1 correction.

A corrupt version-2 file follows the tracker's existing corruption behavior and starts with fresh in-memory state. Normal restarts over valid state preserve the brake, which is the requested failure mode. Hardening corrupt-state recovery into a fail-closed operator repair state is a broader storage-policy change and is not smuggled into this patch.

Version-1 outstanding entries have no historical content key. They preserve the existing in-flight refusal but cannot retroactively consume a content attempt. The first post-upgrade content reservation begins the new bounded history.

---

## 3. Level-of-abstraction fit

The retry authority belongs in `OutstandingPromptTracker`, which already owns the durable question “may this mentor send another prompt to this mentee?” Adding a second disconnected store would create competing truth for the same actuation boundary.

Content normalization and hashing live beside the attempt state. `AgentServer` owns orchestration: reserve, call transport, mark immediate failure, append sent history, and emit degradation. `runMentorTick` only awaits and surfaces the structured outcome. No transport adapter is taught mentor-specific policy.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

The static retry count is appropriate hard authority because “never perform identical autonomous sends without a bound” is a safety invariant, not a competing-signals judgment. The gate uses exact normalized content, explicit counters, and durable state. It does not guess user intent, message quality, or semantic equivalence.

The degradation event is signal-only. It cannot reopen the breaker, alter the agenda, change transport routing, or authorize another send. The durable tracker remains the sole authority.

---

## 4b. Judgment-point check

No LLM or heuristic decides whether the retry budget is exhausted. The decision inputs are a stable content key, integer attempt count, fixed maximum, outstanding correlation, and store health.

The number three is a conservative structural ceiling for an existing retry loop that previously had no ceiling. It is not exposed as configuration in this patch, avoiding a migration surface and preventing an operator from accidentally configuring the invariant away.

---

## 5. Interactions

- **Outstanding timeout:** an expired correlation is still swept, but its content attempt remains. Expiry permits evaluation of the next attempt; it no longer resets history.
- **Immediate transport refusal:** the pre-send reservation remains counted while the outstanding correlation is removed, so a dead transport reaches the same breaker without waiting twenty minutes per attempt.
- **Successful delivery:** the correlation stays outstanding until its matching reply or timeout.
- **Matching reply:** clears the outstanding row and content retry episode.
- **Late reply after timeout:** remains classified by the existing late/unknown-correlation behavior and does not silently reopen an exhausted content key.
- **Restart:** entries, retry counts, and `escalatedAt` reload from one atomic JSON file.
- **Concurrent tick:** the runner's existing single in-flight guard plus the tracker's per-mentee outstanding check prevents overlapping reservations in this process.
- **Multi-machine:** state remains machine-local, matching the existing mentor runner's single active process. This patch adds no replicated authority.
- **Escalation flood:** `recordRetryExhaustionEscalated` persists the latch before the degradation call. Repeated ticks see the open breaker and decline the signal.
- **State growth:** 64 unresolved keys is a hard ceiling; raw message content is absent from this store.

---

## 6. External surfaces

`GET /mentor/status.lastResult` can now include `deliveryReason` for a live tick. Existing fields and status codes remain unchanged; JSON omits the optional field when no delivery-layer reason exists.

Operators may receive one existing-style degradation alert under the new feature name `mentor.delivery-unconfirmed-retry-exhausted`. Its content describes a delivery failure and the automatic suppression. It does not ask the operator to edit files, run commands, or diagnose raw internals.

No Telegram API call shape, Threadline identity rule, bot token handling, topic selection, endpoint, config key, or dashboard surface changes.

---

## 6b. Operator-surface quality

The only operator-facing addition is the existing degradation channel's plain-language event. It leads with the condition and effect: prompt delivery could not be confirmed, so identical sends stopped. It exposes no hash, correlation id, state path, token, or stack trace as primary content. There is no destructive action. The message is short enough for phone width and introduces no form or technical input.

---

## 7. Multi-machine posture

**Posture: intentionally machine-local.** The mentor runner and its outstanding-prompt tracker already live on the machine executing Echo's mentor tick. A send is reserved and actuated by that same process. Replicating attempt authority without a cross-machine single-writer contract would create two counters that could each admit three sends.

This patch preserves the existing one-process ownership boundary. If mentor execution becomes active-active in the future, the tracker must move behind a shared claim/lease before that rollout; this change does not claim cross-machine safety for a topology that is not currently enabled.

---

## 8. Rollback cost

Reverting the code restores version-1 behavior. Older code reads the version-2 file as unsupported and starts fresh, so rollback removes the brake until the prior version is restored. No database migration or user-data conversion is required. The file contains only machine-local mentor retry metadata and can be regenerated.

The additive `deliveryReason` field disappears on rollback. Existing consumers already tolerate its absence.

---

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`
**Closure:** `guard`

The guard is the durable pre-transport reservation plus the three-attempt content-key breaker. Unit tests prove the first send, cap, independent novel content, restart persistence, one-shot escalation, normalization, and capacity bound. The production-wiring E2E test drives three refused transport attempts, requires the fourth identical attempt to be suppressed, and requires a new message to retain an independent attempt.

Steady state for one unanswered content key is therefore: at most three outbound attempts, one exhaustion signal, then permanent suppression in valid durable state. The escalation path cannot recursively send another mentor prompt.

---

## Evidence pointers

- Refusal-first: four new tracker tests failed against unmodified source with `reserveSend is not a function`; ten pre-existing tracker tests remained green.
- Focused proof after implementation: 77/77 across tracker, tick, runner, route integration, production lifecycle, and mentor config hot-read coverage.
- Static validation: `npm run build` and `npm run lint` pass.
- No route, config, transport identity, LLM breaker, cadence, budget, or agenda change.

---

## Causal autopsy

**Origin:** latent.

The correlation-scoped anti-ping-pong guard was correct within one reply window but treated timeout expiry as the end of all retry history. That latent reset became an unbounded loop when Telegram visibly accepted bot-authored posts that the mentee bot could not ingest. Every correlation expired normally, so the system repeatedly regenerated and resent identical content while believing each attempt was new.
