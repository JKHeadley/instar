# Side-Effects Review — Token-Burn Detection Phase 4

**Spec**: `docs/specs/token-burn-detection-phase-4.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

## 1. Over-block

The runbook can install a throttle that refuses real LLM calls for up to its TTL (default 60min). Legitimate over-blocks:

- **Sustained legitimate burst** — a long debugging session genuinely needing the LLM gets auto-throttled. Mitigation: Phase 5 ships a one-tap "this is fine, release" button bound to the user's Telegram ID; for Phase 4, release is via `LlmRateGate.revokeThrottle(key)`.
- **Attribution mismatch** — the detector flags `InputDetector::abc` but the actual offender is a different component with similar prompt shape. Throttle goes to wrong key; real offender keeps burning. Phase 6's verification step catches this and escalates.
- **Wrong-environment throttle** — the runbook installs a throttle that affects every LLM caller using that key, including legitimate ones. Mitigation: keys are scoped by `componentName::promptFingerprint` so the throttle is narrow.

## 2. Under-block

- **Unknown::* keys are alert-only by default.** A burn from a user extension the agent has never seen lands as an alert with no automatic throttle. Operator must opt in to `autoThrottleOnUnknown: true`. This is by design (umbrella spec §"Auto-throttle mechanism") — the system refuses to silently strangle user-installed code.
- **Raw-HTTP bypass paths** (grandfathered out of Phase 1 lint) — the throttle is consulted at the chokepoint. Direct callers (`StallTriageNurse`, `CoherenceReviewer`, voice routes) are not gated. Migration is tracked in the Phase 1 grandfather list.
- **Cross-process state.** The gate is in-memory only. A burn that spans a server restart would re-fire from the detector within 60s on the new process, and the runbook would re-install. No stale-state risk; no continuity-of-throttle either.

## 3. Level-of-abstraction fit

- `LlmRateGate` is in `src/monitoring/`. Correct layer.
- `BurnThrottleRunbook` is in `src/monitoring/` alongside the gate it consumes. Correct layer.
- The decision-authority layer (the runbook) is composed with `LlmRateGate` via direct method call rather than going through Remediator's signed-context dispatcher. **Why this is OK for Phase 4**: the runbook will be invoked from `DegradationReporter`'s subscriber chain (which DegradationReporter itself routes via the Remediator F-1/F-8 dispatcher, per the existing Remediator V2 wiring). The runbook's `handle()` receives an already-validated DegradationEvent. The runbook is the "Tier-2 runbook handler" the Remediator already supports.

## 4. Signal-vs-authority compliance

The umbrella spec's table is realised:

| Layer | Authority |
|---|---|
| AttributionResolver (Phase 2) | None |
| BurnDetector (Phase 3) | None — emits signal |
| Remediator V2 dispatcher (existing) | Tier-2 routing |
| BurnThrottleRunbook (Phase 4) | Tier-2 delegated |
| LlmRateGate (Phase 4) | None — enforces decisions only |

The runbook is the only Phase-4 piece with decision authority. The gate cannot decide; it can only enforce. Brittle threshold logic (the detector) cannot block anything directly — it must go through the runbook's `handle()`.

**Compliant.**

## 5. Interactions

- **LlmRateGate signature changed: `decide().reason` enum dropped `phase-1-noop` and added `no-throttle-installed` / `throttle-active` / `throttle-expired` / `runbook-self-exempt`.** Phase 1's test assertion was updated in this PR.
- **`InstallThrottleInput` requires a new `signalId` field** for replay-prevention. The only caller is the Phase 4 runbook, which derives the signalId from the event's timestamp + attribution key.
- **DegradationReporter**: the runbook subscribes via the existing report hook in Phase 5's wiring. Phase 4 only ships the runbook + tests; the wiring is a separate small change.
- **AttributionResolver / BurnDetector**: not touched in this phase.
- **Anthropic provider chokepoint**: not touched. The provider already consults `gate.shouldFire`; with the gate now stateful, the consultation now actually gates.

## 6. External surfaces

- **Telegram messages**: Phase 4 sends plain text via the existing `MessagingToneGate`-routed send path. Phase 5 upgrades to interactive buttons with principal verification.
- **New URGENT-severity escalation case**: when the runbook is being self-attributed, an URGENT message is sent (Phase 4 second-pass review §3). Operators should treat URGENT as the highest action priority.
- **No new endpoints, no new CLI commands.**

## 7. Rollback cost

Three classes of change:
- The gate's stateful upgrade is additive — existing `shouldFire` callers see the new "no-throttle-installed" return reason but their `.allowed` check is unchanged.
- The runbook is a brand-new module — delete the file, nothing else depends on it (subscriber wire lands in Phase 5).
- The `InstallThrottleInput.signalId` requirement is the only API break — but the only caller is the new runbook, also in this PR.

Rollback = single `git revert` with no data migration. The in-memory throttle store self-clears on restart.

## Second-pass review

**Conducted** (required for this phase per `/instar-dev` Phase 5 criteria — touches blocking authority over LLM calls + the word "gate").

Reviewer: general-purpose subagent given the umbrella spec, convergence report, and the three implementation files.

**Verdict**: **Concur with three specific concerns, all addressed in the implementation**:

1. **Capability tokens were infinitely replayable** — fixed via `signalId` nonce in canonical payload + consumed-IDs map in the gate. Test `refuses a replayed signalId` exercises this.
2. **In-process mint exposure** — documented in `computeCapabilityToken` JSDoc. The HMAC defends the cross-process boundary only; in-process integrity depends on the `/instar-dev` review discipline. Future move of the mint to a separate runbook service is sketched in the JSDoc.
3. **Self-attribution silently swallowed the signal** — replaced with URGENT escalation Telegram alert. Test `alert-only-self-attribution refuses to throttle AND emits high-severity escalation` exercises this.

Reviewer also flagged minor items (alertTopicId default leaks Justin's topic in third-party agents; async errors from `sendTelegram` are uncaught; `extractTrigger` regex coupling is fragile) — accepted as known/minor and documented in source comments.

The reviewer's report is in the convergence audit summary; the three substantive concerns are tracked above with their fix locations.
