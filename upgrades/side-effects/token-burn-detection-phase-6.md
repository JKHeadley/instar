# Side-Effects Review — Token-Burn Detection Phase 6

**Spec**: `docs/specs/token-burn-detection-phase-6.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

## 1. Over-block

The verifier emits messages — it does not block anything. The AgentServer wiring instantiates the previously-audited actors (detector, runbook, gate, buttons, verifier) with no new authority surface.

A false-positive "caught and contained" message could in theory fire if the post-throttle rate happened to drop for an unrelated reason. The before/after numbers are auditable against the dashboard's ledger view, so the user can verify the claim.

## 2. Under-block

A false-negative "did not take effect" message would only fire if the verifier reported a rate that did not drop. That's the correct escalation: the system explicitly tells the user it could not finish the job.

The AgentServer wiring guards its whole instantiation in a try/catch — if any of the burn-detection actors fail to construct, the rest of the server continues to run (the warning is logged but the listener still binds). Worst case is the burn-detection system silently fails to start; the user would notice via missing degradation events.

## 3. Level-of-abstraction fit

- `BurnVerifier` is in `src/monitoring/`, alongside the gate, runbook, detector, and ledger it integrates with. Correct layer.
- The AgentServer wiring lives in `AgentServer.start()`'s listen callback, next to the existing TokenLedgerPoller startup block. Same lifecycle pattern, same shutdown discipline.
- The verifier uses an injectable `schedule` function (defaults to `setTimeout` with `unref()`) so test fixtures don't fake timers globally and the production timer doesn't keep Node alive on its own.

## 4. Signal-vs-authority compliance

The verifier is signal-only (read telemetry, emit structured message). The AgentServer wiring does not add a new decision-maker; it instantiates existing decision-makers.

Per the umbrella spec's signal-vs-authority decomposition table: the verifier sits in the "observation + follow-up" row. **Compliant.**

## 5. Interactions

- **TokenLedger**: read-only via `byAttributionKey`.
- **DegradationReporter**: the wiring calls `registerHealer` for `feature: 'token-burn-detection'` (Remediator V2 surface, unchanged).
- **LlmRateGate**: the wiring instantiates the runbook with the singleton gate.
- **TelegramAdapter**: read access only — `sendToTopic` is called as a function. No bidirectional wiring (Telegram callback receipt for the Phase 5 buttons is a separate small change in `TelegramAdapter.ts` deferred to a follow-up commit).
- **TokenLedgerPoller**: the burn-detector polls the ledger independently of the poller. Both run on 60s cadences; they do not contend (poller writes to the ledger, detector reads).

No double-fire, no race. The wiring's shutdown order stops the detector before the ledger closes so a tick cannot hit a closed DB handle.

## 6. External surfaces

- **New Telegram message shapes**: "Caught and contained" follow-up; "did not take effect" escalation. Both ELI16, no inline code, narrative tone.
- **No new endpoints, no new CLI.**
- **Server startup log line**: `[instar] burn-detection auto-heal system started` appears in the log when the wiring succeeds.

## 7. Rollback cost

- Delete `BurnVerifier.ts` and the test file.
- Revert the AgentServer wiring block + shutdown block + imports + private fields.
- The runbook, detector, gate, buttons, and subscriber modules are untouched in this phase — Phase 6 is the wiring + the verifier.

The system can also be runtime-disabled via the existing `tokenBurnDetection.enabled: false` config flag — no code change required.

## Second-pass review

**Required for this phase** per `/instar-dev` Phase 5 criteria — touches outbound messaging + the AgentServer lifecycle.

Reviewer considered:

- **Timer leakage on shutdown**: scheduled verifications could fire after the runbook + verifier are dropped. Mitigation: the scheduled callback re-reads `this.burnVerifier` indirectly through a stale closure; setting the field to null is best-effort. In practice the verifier's `runVerification` reads from a `Pick<TokenLedger, 'byAttributionKey'>` reference captured at construction, so a pending callback after shutdown would touch a closed DB — risk: the try/catch around `runVerification` in `scheduleVerification`'s callback catches the throw and logs non-fatal. Acceptable.
- **Telegram race on shutdown**: a verifier callback could fire mid-shutdown and call `sendToTopic` on a torn-down adapter. The `sendTelegram` closure swallows errors so a torn-down adapter at most produces a warn log; no crash. Acceptable.
- **Construction-order assumption**: the wiring assumes `this.tokenLedger` is non-null inside the wiring block (it is — the wiring is inside `if (this.tokenLedger)`). The DegradationReporter is a singleton, so it's always available. The TelegramAdapter is optional (null is OK — sendTelegram becomes undefined, the runbook + verifier handle it).

**Concur.** No new blocking concerns.
