# Side-Effects Review — WS5.2 Operator-Facing Completion + "Operators Act in Taps, Not Text"

**Version / slug:** `ws52-operator-tap-not-text`
**Date:** `2026-06-18`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required — high-risk (gate + credential-enrollment + operator surface); to be appended before commit`

## Summary of the change

Completes the operator-facing half of WS5.2 Account Follow-Me (the security primitives + cross-machine delivery already shipped in #1208–#1218) and closes the two gaps a live-proof attempt exposed: (1) the only way to approve an account-follow-me mandate was an "Advanced — author by hand" form requiring a pasted JSON authorities blob + agent fingerprints; (2) a delivered mandate sat inert on the target — `AccountFollowMeService.onMandateDelivered()` had zero callers, so enrollment never started. It adds: **Part A** a one-tap Approve card in the Subscriptions tab (`dashboard/subscriptions.js` — `renderFollowMeApproveCard`/`renderFollowMeOffers`/`buildFollowMeIssuePayload`); **Part B** the connector that drives delivery→point-of-use re-verify→single-flight-gated enrollment→honest operator surfacing (`src/coordination/driveFollowMeEnrollment.ts`, `followMeConsumerSweep.ts`, `AccountFollowMeSingleFlight.ts`, `enrollPointOfUseCheck.ts`, `AccountFollowMeOperatorOutbox.ts`); and **Part C** the "Operators Act in Taps, Not Text" standard with two enforcement arms — a build-time mechanical check (`scripts/lib/operator-surface.mjs` `operatorSurfaceRequiresRawInput` wired into `scripts/instar-dev-precommit.js`) and a runtime observe-only signal (`src/core/rawTextRequestDetector.ts` consumed by `observeRawTextRequest` in `src/server/routes.ts` `checkOutboundMessage`). FD1 also sets a 1h default expiry on `/mandate/issue-for-machine` when the card omits it. Decision points touched: the build-time operator-surface gate (add), the outbound-message review path (add a signal), enrollment start (add point-of-use re-verify + single-flight authority), mandate issuance expiry (modify).

## Decision-point inventory

- `operatorSurfaceRequiresRawInput` (build-time, `scripts/instar-dev-precommit.js`) — **add** — refuses a commit that stages an operator surface requiring raw/technical input, unless marked `operator-surface-power-user`.
- `observeRawTextRequest` in `checkOutboundMessage` (`src/server/routes.ts`) — **add (signal only)** — records, never blocks, an outbound message that asks the operator to paste JSON / run a multi-step technical flow.
- `checkDeliveredMandateUsableForEnroll` (`src/coordination/enrollPointOfUseCheck.ts`) — **add** — fail-closed gate on enrollment: bounds + expiry + live revocation re-check at point-of-use.
- `AccountFollowMeSingleFlight.tryClaim/transition` — **add** — gates duplicate enrollment per `accountId::targetMachineId` (CAS, TTL dead-holder heal).
- `/mandate/issue-for-machine` expiry default (`src/server/routes.ts`) — **modify** — server computes a 1h expiry when the tap-card omits one.
- The mandate gate itself (`MandateGate.evaluate`) — **pass-through** — unchanged; enrollment-start still calls it deny-by-default.

---

## 1. Over-block

**arm-1 (build-time gate):** Could reject a legitimate dashboard/markup file that contains JSON/fingerprint-shaped text for a *non-input* reason — e.g. showing a fingerprint as muted "for support" metadata, or a JSON example inside a code-comment. Mitigated structurally: the detector targets input affordances and paste/copy *instructions* directed at the operator (labeled inputs whose value is a JSON template, "paste the … below", curl/fingerprint-token input labels), not arbitrary display text; and a genuine power-user surface can carry the `operator-surface-power-user` marker to allowlist itself. Concrete non-block case verified in tests: a card that shows the account/target as plain words with raw ids only as `data-*` support attributes passes.

**point-of-use re-verify / single-flight (runtime):** Could refuse a legitimate re-enrollment if a prior single-flight record is wedged. Mitigated by TTL + dead-holder heal (a stale holder is reclaimed), and `completed` is the only terminal that blocks re-drive (correct — re-driving a completed enroll would re-mint).

## 2. Under-block

**arm-1:** A surface that solicits raw input through a channel the static scan can't see — an image, a dynamically-built label, or text assembled at runtime — would pass the build gate. This is exactly why arm-2 exists as the runtime backstop: even if a bad surface ships, the moment the agent *asks the operator in a message* to paste/run technical content, arm-2 records it. Neither arm claims completeness alone; together they cover build-time authored surfaces + runtime-authored asks.

**arm-2 (signal):** High-precision by design (vague "take a look" never fires), so it under-fires on obfuscated phrasings. Acceptable: it is observe-only; its job is to measure the real false-negative/positive rate before any future warn/block surface, not to be the gate.

## 3. Level-of-abstraction fit

Correct layering. arm-1 is a **build-time CI/precommit gate** — deterministic static analysis on developer-authored files, the right layer for "this surface would be bad before it ships." arm-2 is a **detector that feeds the existing `checkOutboundMessage` review path** as a sibling to `observeSelfViolation`/`observePrincipalCoherence` — it does not run parallel-to a smarter gate, it joins the established observe-only lane. The point-of-use re-verify deliberately sits at *enrollment start* (the irreversible side-effect boundary) rather than at delivery, so a revoke/expiry between delivery and enroll is caught. The connector orchestration uses the existing `EnrollmentWizard` + `DeliveredMandateStore` rather than re-implementing enrollment.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — arm-2 produces a signal consumed by the existing outbound-review path; it never blocks, delays, or rewrites a message (fire-and-forget, fail-closed to silence).
- [x] Yes, but appropriately — arm-1 holds build-time blocking authority, which is legitimate: it is deterministic static analysis on developer code at commit time (the same class as every other instar-dev precommit check), not a brittle runtime detector gating live agent behavior. The point-of-use re-verify + single-flight hold runtime authority over the *credential-enrollment side-effect*, but with deterministic, fail-closed checks (revocation/expiry/bounds — not NLP/heuristics), which is the correct posture for a security-critical irreversible action.

Narrative: the brittle/NLP component (raw-text detection) is confined to arm-2 and is signal-only. The authoritative components (arm-1 build gate, enroll re-verify, single-flight) are all deterministic. No brittle logic holds runtime block authority.

## 5. Interactions

- **Shadowing:** `observeRawTextRequest` runs *after* `observeSelfViolation` and `observePrincipalCoherence` in `checkOutboundMessage`; all three are independent fire-and-forget observers — none shadows another, and the message send is unaffected by all three.
- **Double-fire:** the operator outbox (`claimEmit({ledgerKey,state,eventId})`) is the structural guard against the connector emitting two operator messages for the same ledger state; the consumer sweep also skips `completed`/live-in-flight records so a boot-sweep + tick can't double-drive.
- **Races:** single-flight CAS + the durable ledger serialize concurrent enroll attempts across sweep/tick/manual paths; the outbox dedup serializes surfacing.
- **Feedback loops:** none — arm-2 writes a JSONL signal that nothing reads back into the send path.

## 6. External surfaces

- **Operator (phone):** the one-tap Approve card (Subscriptions tab) + a Telegram login link surfaced by the fronting machine — both phone-completable (Mobile-Complete satisfied: the operator's only actions are tap-Approve + the final OAuth login, no terminal/API).
- **Other machines:** cross-machine by construction — the fronting machine owns the operator loop; the target enrolls and returns the LoginArtifact over the mesh (`follow-me-enroll-status`); mandate delivery via the existing `account-follow-me-mandate-deliver` verb. No token ever crosses (only a login link + public device code).
- **Persistent state:** new additive JSONL/file ledgers (single-flight, operator outbox, `raw-text-request-signals.jsonl`) — none mutate existing state; all dev-gated.
- **Timing:** device-code login TTL is surfaced honestly; offline-target enrollment is restart-safe via the durable consumer sweep.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change adds an operator surface (`dashboard/subscriptions.js`), so this section is required.

1. **Leads with the primary action?** Yes — the card renders the plain-language headline ("Let *<machine>* use your *<account>* subscription") with the Approve button + PIN field as the card's primary, visible block; no Advanced toggle, no JSON.
2. **Zero raw internals as primary content?** Yes — agent fingerprints are NEVER in the DOM; only non-sensitive account/target ids appear as `data-*` support attributes, never as headline content. (The card itself passes `operatorSurfaceRequiresRawInput` — it dogfoods arm-1.)
3. **Destructive actions de-emphasized?** N/A — the card is constructive (Approve) only; no revoke/delete affordance on this surface.
4. **Plain language + phone width?** Yes — labels read as a non-engineer would say them; the card is a single-column block (PIN box + button) with no table/horizontal scroll; verified in the jsdom test.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: replicated + proxied, by construction — this feature only exists across machines.** The operator-facing loop is **anchored on the fronting (lease-holding) machine** (it owns Telegram egress and the verified operator binding); the target machine enrolls and returns its LoginArtifact/status over the mesh (`follow-me-enroll-status` verb) — a proxied surfacing, never the target trying to text the operator directly (the round-1 convergence finding). Durable state: the single-flight ledger is keyed `accountId::targetMachineId` and the delivered-mandate store is per-machine durable, so an offline-at-delivery target enrolls when it returns (restart-safe, does not strand on topic transfer). User-facing notices: the operator outbox guarantees exactly one message per ledger state, surfaced from the fronting machine (one-voice). URLs: the device-code login link is the provider's own URL (machine-independent); no localhost link is surfaced.

## 8. Rollback cost

Pure code change behind the dev-agent gate (dark on fleet). Back-out = revert the commit and ship a patch. No data migration: the new ledgers (single-flight, outbox, raw-text-request-signals) are additive append-only files that are simply ignored when the code is reverted. No agent-state repair, no user-visible regression during the rollback window (the feature is not live on the fleet). arm-1 (build gate) reverting just removes a precommit check; arm-2 reverting removes an observe-only writer. The standard text in the constitution would revert with the doc.

---

## Conclusion

This review produced no design changes — the converged spec (3 rounds, cross-model codex gpt-5.5 + gemini-2.5-pro endorsed) already addressed the material findings (cross-machine surfacing re-architecture, durable single-flight, point-of-use revocation re-check, signal-not-authority arm-2). The implementation matches the converged design and is verified green (full `tsc --noEmit` clean; 78 unit tests across 9 files pass). The brittle component is confined to a signal; all authorities are deterministic/fail-closed. The change is clear to ship **pending** (a) the required Phase-5 second-pass review appended below, and (b) the operator's informed `approved: true` on the converged spec — the design changed materially after the initial build-approval, so that approval must be re-confirmed against the converged report before commit.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only audit), 2026-06-18
**Independent read of the artifact + code: CONCUR**

The reviewer independently verified all six high-risk dimensions against the actual code (citing file:symbol), not the artifact's claims:

- **Signal vs authority** — arm-2 `observeRawTextRequest` is invoked at `routes.ts:1900` as `void observeRawTextRequest(...).catch(()=>{})` — fire-and-forget, not awaited, structurally independent of the send; the gate decision happens separately at `evaluateOutbound` (1904); dev-gated + double try/catch fail-closed to silence. arm-1 (`operator-surface.mjs:83`, wired `instar-dev-precommit.js:1011`) operates only over staged files in the precommit script — build-time CI authority only.
- **Fail-closed** — `enrollPointOfUseCheck.ts:50` denies bounds-mismatch → bad-expiry → expired → revocation-unknown (try/catch→deny) → revoked, deny-by-default ordering correct. `AccountFollowMeSingleFlight.tryClaim` refuses re-claim only while ACTIVE + within TTL; `completed` is skipped by the sweep (`followMeConsumerSweep.ts:64`) so no re-mint; dead-holder TTL heal prevents permanent wedge; `transition` enforces holder-mismatch.
- **No-silent-stall** — `driveFollowMeEnrollment.ts` emits exactly one operator message on every terminal outcome via `outbox.claimEmit` keyed `${ledgerKey}::${state}` (redelivery/restart collapse to one); a denied mandate deliberately emits nothing (operator already knows); `surfaceToOperator` failures are caught, never thrown out.
- **Leakage** — card writes only account/target ids as sanitized `data-*` + plain headline (no fingerprints, no innerHTML, verification URL as copy-text); the signal file writes `{ts,topicId,reasons}` only, never the message body; operator messages carry URL+code only, never a token.
- **Multi-machine** — ledger keyed `accountId::targetMachineId` (restart-safe, offline target enrolls on return); surfacing anchored on the fronting machine via injected `surfaceToOperator`/`frontingMachineId` — the target returns status over the mesh, never texts the operator itself.
- **Over/under-block** — no concrete hole; the detector targets input/paste affordances not display text (the card passes); the known evasion (a JSON template hoisted to an imported constant) is honestly documented as out-of-scope, backstopped by arm-2 + review rather than pretended airtight.

Two non-blocking observations, both confirmed fine: `logToneGateDecision`'s `textHead` slice is pre-existing tone-gate audit logging (not this change's signal path, which stores no text); the FD1 1h default only fills a missing expiry, still rejects an invalid/past explicit one, and issuance stays PIN-gated + dev-gated through the signed `store.issue` — no authority bypass.

**Verdict: clear to ship pending only the operator's informed `approved: true` on the converged spec.**

---

## Evidence pointers

- `npx tsc --noEmit` — clean (full worktree), 2026-06-18.
- `npx vitest run` (9 files) — 78/78 pass: operator-surface-gate (20), account-follow-me-single-flight (11), enroll-point-of-use-check (8), account-follow-me-operator-outbox (7), raw-text-request-detector (9), drive-follow-me-enrollment (7), follow-me-approve-card (6), follow-me-issue-payload (5), follow-me-consumer-sweep (5).
- Spec: `docs/specs/ws52-operator-tap-not-text.md` (review-convergence 2026-06-17T23:15Z, iterations 3, cross-model codex-cli:gpt-5.5).
- Convergence report: `docs/specs/reports/ws52-operator-tap-not-text-convergence.md`.
