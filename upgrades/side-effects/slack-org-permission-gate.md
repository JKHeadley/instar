# Side-Effects Review — Slack org permission gate (Slice 0)

**Version / slug:** `slack-org-permission-gate`
**Date:** `2026-06-08`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (single-author; observe-only, dark-by-default)`

## Summary of the change

Adds the first vertical slice of the Slack organizational permission system
(`docs/specs/SLACK-ORG-INTEGRATION-SPEC.md`). New `src/permissions/` module: a
`SlackPermissionGate` that turns a verified principal + natural-language request into
an `allow | clarify | refuse | step-up` verdict, composed from `RolePolicy`
(role→tier ceilings + an enumerated, deterministic floor), `HeuristicIntentClassifier`
(conservative floor detection), `AnomalyScorer` (relationship step-up hook),
`SlackPrincipalResolver` (verified-Slack-id → principal), and an observe-only
`PermissionDecisionLedger`. Wired into `SlackAdapter._handleMessage` via an optional
`SlackPermissionObserver` and into server startup behind a `permissionGate.observeOnly`
config flag (DARK by default). Adds `UserProfile.slackUserId`/`orgRole`,
`UserManager.resolveFromSlackUserId`, two read routes (`/permissions/decisions`,
`/permissions/scenario-suite`), and a state-registry entry for the ledger.

## Decision-point inventory

- `SlackPermissionGate.evaluate` — **add** — the authority decision (allow/clarify/refuse/step-up). Ships OBSERVE-ONLY (logs, never blocks).
- `RolePolicy` (floor + ceilings) — **add** — deterministic Layer-0 floor; pure, no I/O.
- `SlackAdapter._handleMessage` observe call — **add (pass-through)** — fire-and-forget; does not alter the existing flow.
- `UserProfile` / `UserManager` — **add** — additive optional fields + one new resolution method; no existing path changed.

## 1. Over-block

Observe-only: it blocks **nothing** today, so over-block has no live effect — it can only over-LOG a "would-refuse." Measured over-refusals in the ledger are exactly the FP signal we want before enabling enforcement. When enforcement is later turned on, the known over-block risks are: (a) the heuristic classifier tags a benign message as a floor action (e.g. "delete this slack message" → matches destructive-data) and refuses; (b) a relayed-but-legitimate request ("the client asked us to email them") trips external-send. Both are why enforcement stays off until the observed FP rate is acceptable (§11).

## 2. Under-block

The deterministic heuristic classifier will miss obfuscated floor requests (e.g. "send forty grand to…" spelled out, or a deploy phrased without the word prod). This is acceptable for the floor because: (a) observe-only today, and (b) the production design adds an LLM classifier ABOVE the floor for ambiguity — but the floor itself must stay deterministic/fail-closed (a missed floor classification falls through to a non-floor tier and is still role-gated). Also: the anomaly scorer is a coarse heuristic (urgency + atypical-action) and will under-flag a calm, in-character-looking compromise — Pillar 3 ships observe-only precisely to measure this before it gates.

## 3. Level-of-abstraction fit

Correct layering. The **floor** is a low-level deterministic primitive (cheap, conservative, fail-closed) — appropriate because the dangerous path must NOT depend on an LLM that could fail-open (per the "no silent degradation to brittle fallback" standard). The **judgment band** is authority-level and is designed to be LLM-backed in production via the injectable `IntentClassifier` interface (the heuristic is the deterministic test/fallback path, and it routes ambiguity to CLARIFY, never to a silent allow). The gate does not re-implement `ExternalOperationGate`; the spec wires the floor THROUGH it + the Coordination Mandate in Phase 1 (this slice stands alone as the decision core).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface **yet**. It ships observe-only: the gate produces a logged verdict (a signal) and never blocks delivery.

The gate is structurally an authority (it WILL block when `enforce` is enabled), but its blocking logic is NOT brittle: the floor is deterministic-conservative-fail-closed, and the judgment band is designed for LLM backing with conversational context. **Follow-up flagged:** before `enforce: true` is ever set (a later phase), this artifact's §1/§2 must be revisited with real FP-rate data from the ledger, and the judgment-band LLM classifier must be the one holding authority — not the heuristic fallback.

## 5. Interactions

- **Shadowing:** the observe call runs AFTER the fail-closed `authorizedUserIds` AuthGate and BEFORE the `mention-only` skip, so it sees every authorized message (directed or overheard) without changing whether the message is processed. It shadows nothing (it has no return effect).
- **Double-fire:** none — it only writes to its own ledger; it does not act on the event.
- **Races:** the ledger is append-only single-writer per process; the observe call is `void`'d (fire-and-forget) so it cannot delay the handler.
- **Feedback loops:** none — the ledger is read-only observability; nothing consumes it to change behavior.

## 6. External surfaces

- **Other agents / install base:** none — the whole feature is dark by default (no config = no gate attached); pure no-op for every existing agent.
- **External systems (Slack):** none — no new Slack API calls; the observe path is local.
- **Persistent state:** one new append-only JSONL ledger (`state/slack-permission-decisions.jsonl`), registered in `state-coherence-registry.json` (machine-local, append-only, transport none). Created lazily; bounded by `readRecent(limit)`.
- **HTTP:** two new authenticated GET routes (Bearer-gated like all routes); read-only.

## 7. Rollback cost

Pure additive code + one optional config flag. Back-out = revert the commits and ship a patch. No migration needed: `UserProfile.slackUserId`/`orgRole` are optional fields (absent on existing profiles = no effect); the ledger file is observe-only and can be deleted with zero consequence. No agent-state repair, no user-visible regression during rollback (the feature is dark on every install).

## Conclusion

The review produced no design changes — the slice was built observe-only and floor-deterministic by intent, which is exactly what the signal-vs-authority and "no silent degradation" standards require for a gate that will eventually hold blocking authority. One concern is flagged for the NEXT phase (not this one): the §4 follow-up requiring an FP-rate review and an LLM-backed judgment band before `enforce` is ever enabled. The change is clear to ship as a dark, observe-only foundation pending the spec's `approved: true`.

## Evidence pointers

- 38 tests green: `tests/unit/slack-permission-gate.test.ts` (23), `tests/unit/slack-principal-resolver.test.ts` (7), `tests/unit/slack-permission-wiring.test.ts` (5), `tests/integration/permissions-routes.test.ts` (3).
- The six worked-example rows + their expected/actual verdicts: `GET /permissions/scenario-suite` (and `src/permissions/testing/SlackScenarioHarness.ts`).
- No-regression: 90 tests green across touched modules (slack adapter, user-manager, permissions).
