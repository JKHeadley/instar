# Security Review: Round 2

**Review ID:** 20260321-234429
**Round:** 2
**Reviewer Role:** Security Specialist
**Date:** 2026-03-21
**Spec:** `specs/consent-discovery-framework.md` (Rev 2 — post-review)
**Prior Review:** `specreview/output/20260321-232155/security.md`

---

## Round 1 Issue Resolution

| Issue | Round 1 Severity | Status | Assessment |
|-------|-----------------|--------|------------|
| CRIT-1: Raw `userMessage` passed to LLM evaluator | Critical | RESOLVED | Evaluator now receives sanitized `topicCategory` and `problemCategories` (structured labels), never raw user text. Output validation confirmed: `featureId` must match eligible set; `surfaceAs` capped by autonomy profile. Structural delimiters specified in prompt. |
| CRIT-2: `/features/*` endpoints unauthenticated | Critical | RESOLVED | Spec now explicitly states: "All `/features/*` endpoints require Bearer token authentication." 401 on unauthenticated requests. |
| HIGH-1: `POST /features/:id/state` bypasses state machine | High | RESOLVED | Endpoint renamed to `POST /features/:id/transition`. Valid transitions table is explicitly enumerated; invalid transitions return 422 with valid alternatives. Regression transitions (e.g., `disabled → undiscovered`) are not in the table and thus rejected by default. |
| HIGH-2: `autonomous` tier activation without server-side verification | High | RESOLVED | Renamed to `self-governing`. `→ enabled` transitions on `network`/`self-governing` tiers now require a `consentRecord` in the request body. Server validates presence of consent record before allowing transition. |
| HIGH-3: `recentProblems` leaks sensitive data to cloud LLM | High | RESOLVED | `recentProblems` is now `problemCategories: string[]` — structured category labels only (e.g., `"high-skip-rate"`, `"session-stall"`). No raw error messages, stack traces, or paths pass to the evaluator. |
| HIGH-4: `declined → aware` governed by LLM judgment | High | RESOLVED | Transition now requires deterministic criteria: topic category change + N days elapsed, OR feature version change (`featureVersion` field), OR explicit user re-inquiry. Criteria are evaluated server-side. No LLM judgment involved. |
| MED-1: `enableCommand`/`disableCommand` as executable strings | Medium | RESOLVED | Replaced with structured `EnableAction` objects (`{method, path, body}`). These are typed and validated at startup, never passed to the LLM evaluator. |
| MED-2: `autonomous` profile auto-enables `informational` features silently | Medium | RESOLVED | Rev 2 states: "Even `informational` tier features require a logged consent event (no auto-enable)." The `autonomous` profile behavior table confirms no auto-enable at any tier. |
| MED-3: Discovery event log access control unspecified | Medium | PARTIALLY RESOLVED | Log is now JSONL at `.instar/state/discovery-events.jsonl`. The spec defines 90-day retention and append-only writes. However, it still does not specify: (1) whether this path is excluded from dashboard file viewer, (2) whether it is included in backup snapshots, (3) access control for the log endpoint. |
| MED-4: No rate limiting on `POST /features/evaluate-context` | Medium | RESOLVED | Rate limiting now specified: max 3 calls/session, 5-minute minimum interval, 10-minute result cache by topic. Hard 5-second timeout with fail-open. |
| MED-5: Multi-user discovery state isolation unresolved | Medium | RESOLVED | All state keyed as `(userId, featureId)` in SQLite from day one. Single-user defaults to `userId: "default"`. Multi-user derives from authenticated session. |

---

## New Issues (Introduced by Revisions)

### NEW-1: Consent Record Integrity — No Tamper Detection

**Severity:** Medium
**Component:** `ConsentRecord`, `discovery.db` consent table

The spec now requires `consentRecord` for `network`/`self-governing` tier activation. The consent record is stored in SQLite and referenced via `consentRecordId` in `FeatureState`. However:

- The consent record is written by the calling code (the agent itself) with no external verification
- The `mechanism` field (`'explicit-verbal' | 'explicit-written' | 'profile-blanket'`) is agent-reported — the server accepts whatever the caller claims
- SQLite on disk is mutable by anyone with filesystem access; there is no integrity check

An attacker with local file access (or a compromised agent process) can write consent records claiming `mechanism: 'explicit-verbal'` for features the user never actually consented to. Unlike a signed audit trail, these records provide plausible-deniability for unauthorized activations rather than genuine proof.

**Mitigation:** Consider HMAC-signing consent records at creation time (the synthesis noted this as P3 for the event log — it is more critical here for actual consent records). At minimum, the spec should acknowledge this limitation and not characterize consent records as "proof of consent" — they are "records of claimed consent."

---

### NEW-2: `featureVersion` Field Creates Consent Bypass Via Version Bump

**Severity:** Medium
**Component:** `declined → aware` deterministic criteria, `FeatureDefinition.featureVersion`

The `declined → aware` transition is now deterministic — it fires when the feature's `featureVersion` changes. This is a significant improvement, but it introduces a new vector: the feature's author (instar core, or any code that registers features) controls `featureVersion`. An attacker who can increment a feature's version — or a developer who does so carelessly — can reset all user declines for that feature without the change being "significant" from the user's perspective.

The spec does not define what constitutes a version-worthy change. If a feature's wording, icon, or minor behavior is tweaked and `featureVersion` is bumped, every user who declined it gets re-surfaced. This is exactly the GDPR Article 7 "freely given consent" concern from Round 1, now operationalized into a deterministic bypass.

**Mitigation:** Define criteria for when `featureVersion` may be incremented in a way that resets declines (e.g., "material change to data implications or capability scope, not cosmetic changes"). Surface the version change reason when re-surfacing: "I'm mentioning this again because [Feature X] was updated: [changelog]." This was partially addressed by the `declined → aware` spec language but the version bump loophole is not closed.

---

### NEW-3: `self-governing` Tier Activation Flow Has No Out-of-Band Confirmation

**Severity:** Medium
**Component:** `→ enabled` transition for `self-governing` tier features

The `consentRecord` requirement for `self-governing` tier is a structural improvement, but the consent record is generated by the agent and submitted in the same API call that activates the feature. This means the activation and the "consent" are atomic — there is no independent verification that the user actually made the decision, versus the agent self-generating a consent record.

The original concern (HIGH-2) was that behavioral contract alone is insufficient. The fix addresses this by requiring a consent record, but the consent record is still agent-generated. Compared to alternatives like:
- An out-of-band Telegram confirmation tap
- A short-lived, user-side confirmation token
- A separate `POST /features/:id/consent` step that must precede the `transition` call

...the current design provides documentation of consent rather than enforcement of it.

This is a real but bounded risk: it requires a compromised agent process, which itself represents a system breach. The self-governing tier is still better protected than before. However, the spec's characterization of consent records as proof should be softened.

---

### NEW-4: `DELETE /features/discovery-data` Right-to-Erasure Scope Is Underspecified

**Severity:** Low
**Component:** `DELETE /features/discovery-data`

The endpoint exists, which is a good addition. However:
- It is not specified whether this also deletes consent records (the spec says "Consent records are never automatically deleted — they serve as proof of consent")
- Under GDPR Article 17, right to erasure applies to personal data including consent records once the feature is no longer in use
- A user who wants full erasure but has consent records preserved is not fully accommodated

**Mitigation:** Clarify scope: does this endpoint delete consent records or only discovery state? If consent records are preserved for compliance purposes, document the legal basis for that retention. If the user has disabled all features and requests erasure, the retention justification weakens.

---

### NEW-5: `messageForAgent` in Evaluator Output Is Agent-Rendered — Potential Template Injection Sink

**Severity:** Low
**Component:** `DiscoveryEvaluation.featuresToSurface[].messageForAgent`

The evaluator returns a `messageForAgent` string — a "pre-composed mention" that the agent renders directly to the user. This string is generated by the Haiku evaluator based on the (now sanitized) input context. Two concerns:

1. If the agent renders `messageForAgent` without review — e.g., emits it verbatim into the conversation — a malicious LLM response (jailbroken or adversarially prompted) could inject content into the agent's output stream. The input sanitization in CRIT-1 significantly reduces this risk, but the output path is a new sink not present in Rev 1.
2. The `messageTemplate` with `{{placeholders}}` in `DiscoveryTrigger` was flagged as a potential template injection surface in Round 1 (Design Gaps section). This concern was not addressed in Rev 2. If placeholder substitution happens at render time using any user-controlled values, this is a live injection surface.

**Mitigation:** Specify that `messageForAgent` is a hint, not a verbatim script — the agent may use it as a basis but should apply its own judgment about appropriate phrasing. Define the `{{placeholder}}` substitution model explicitly: which values can be substituted, from what source, and with what escaping.

---

## Remaining Concerns

### RC-1: Discovery Event Log Access Control (from MED-3 — PARTIALLY RESOLVED)

The spec still does not explicitly exclude `discovery-events.jsonl` from the dashboard file viewer allowed paths, specify backup snapshot inclusion behavior, or define an API endpoint for reading the log. These are operational gaps, not design flaws, but they should be addressed in the storage specification before implementation.

### RC-2: Feature Self-Registration Supply Chain Attack (from Round 1 Observations — Not Addressed)

The Round 1 review noted that the FeatureRegistry creates a new extension point, and if features can self-register (e.g., from skill packages), a compromised package could register a malicious feature. Rev 2 does not address this. The `FeatureDefinition.id` field combined with `oneLiner` and `fullDescription` content is exactly the social engineering surface identified in the "OpenClaw malicious skills" incident pattern.

**Status:** Still open. The spec should clarify: can only instar-core code register features, or can skill packages register features? If the latter, what validation is applied?

### RC-3: `messageTemplate` Placeholder Injection (from Round 1 Design Gaps — Not Addressed)

The `DiscoveryTrigger.messageTemplate` field uses `{{placeholders}}` but no escaping specification was provided in Round 1 and none appears in Rev 2. This remains a potential future injection surface. Low severity now (no current attack path is obvious) but should be resolved before Phase 3 implementation.

---

## Approval Status: CONDITIONAL APPROVE

The six critical and high issues from Round 1 are resolved. The spec has been meaningfully hardened: the LLM evaluator no longer receives raw user input, all endpoints are authenticated, the state machine is enforced server-side, `declined → aware` is now deterministic, consent records are required for high-tier activation, and multi-user isolation is specified. The security architecture is substantially improved.

The new issues introduced by the revisions (NEW-1 through NEW-5) are medium-to-low severity and do not block implementation. They should be tracked and addressed before Phase 2 (consent record integrity, NEW-1) and Phase 3 (messageForAgent sink, NEW-5). The `featureVersion` bypass (NEW-2) requires a changelog disclosure requirement in the spec before Phase 2.

Condition for full approval: Address NEW-1 (consent record integrity caveat), NEW-2 (version bump criteria definition), and RC-2 (feature self-registration scope) in the spec before Phase 2 implementation begins. These are specification additions, not redesigns — estimated 30 minutes of revision work.

## Score: 7.5 / 10

## Score Delta: +2.5 from Round 1

---

## What Improved

The most significant security improvement is the LLM evaluator input sanitization (CRIT-1). The evaluator receiving `topicCategory` (a categorical label) and `problemCategories` (structured labels) instead of raw user messages eliminates the primary prompt injection vector. The output validation — requiring `featureId` to exist in the eligible set — closes the loop. This is a well-executed fix.

The `declined → aware` deterministic criteria (HIGH-4) is also a strong resolution. The criteria are concrete, auditable, and server-evaluated. The `featureVersion` field is a clean mechanism for signaling material changes, though its bump criteria need definition (NEW-2).

The `self-governing` consent tier requiring `consentRecord` (HIGH-2) moves the spec from purely behavioral enforcement to a documented record. It does not achieve cryptographic verification, but for an agent running on a local machine where the threat model is a compromised process rather than a network attacker, this is a reasonable balance.

## What Still Needs Work

The three items that should be addressed before Phase 2:
1. **NEW-1 (consent record integrity):** Soften "proof of consent" language; consider HMAC-signing consent records.
2. **NEW-2 (version bump criteria):** Define what constitutes a version-bump-worthy change that resets declines. Require changelog disclosure when re-surfacing post-decline.
3. **RC-2 (feature self-registration):** Clarify whether skill packages can register features and what gates exist.

---

*Security review completed: 2026-03-21. Reviewer: Security Specialist (specreview skill, round 2).*
