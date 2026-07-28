# Side-Effects Review — Fleet guard-posture completeness

**Version / slug:** `guard-heartbeat-unproven-summary`
**Date:** `2026-07-25`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `heartbeat_guard_review`

## Summary of the change

`src/monitoring/guardPostureView.ts` projects the existing `loadBearingUninspectableKeys` summary into the capacity heartbeat as a full `loadBearingUninspectable` count plus at most 16 sorted keys. `src/core/types.ts` adds the optional wire members, and `src/core/GuardPostureStore.ts` includes them in write-on-change semantic equality. `dashboard/glance.js` displays the received count and keys in the existing per-machine Layer-3 record. No guard row, gap membership, anomaly, attention item, notification, machine-health calculation, or placement decision changes.

## Decision-point inventory

No block/allow or actuation decision point is added or modified.

- `buildHeartbeatPostureBlock` — **modify** — adds a bounded read-only projection of an existing summary list.
- `GuardPostureStore.postureSemanticsEqual` — **modify** — recognizes changes to the new wire fields for persistence; it does not decide posture or liveness.
- `machineRecordNode` — **modify** — displays received data at Layer 3 only.
- `GuardPostureProbe` — **pass-through** — deliberately unchanged; it continues to alarm only the pre-existing posture and gap classes.
- `guardPostureProblems` / `machineNeedsAttention` — **pass-through** — deliberately unchanged; the new field cannot alter fleet health or attention classification.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The producer accepts every existing inventory, and older heartbeat payloads without the optional fields remain valid.

---

## 2. Under-block

The 16-key sample can omit individual keys if the load-bearing manifest grows beyond 16, but the full count makes that truncation explicit and the dashboard says how many keys are shown. Today’s manifest contains 13 load-bearing guards, so every current key fits.

One adjacent persistence limitation was observed and left unchanged: `GuardPostureStore.postureSemanticsEqual` does not compare the three older `loadBearingGapKeys`, `loadBearingSoakingKeys`, or `loadBearingAcceptedKeys` lists. Live in-memory posture still updates before the equality check, but a keys-only change to one of those older lists may not be written for restart recovery when every compared count stays equal. This PR compares only the two new fields required for its own durable wiring. The adjacent finding is reported to Echo and is neither fixed nor filed here.

By instruction, the field name retains the earlier `Uninspectable` wording even though `off-runtime-divergent` is more precisely “inspected but unproven.” The code comment and operator label use “cannot prove protection” / “unproven,” preserving wire compatibility without a behavior-free rename.

---

## 3. Level-of-abstraction fit

The projection belongs in `buildHeartbeatPostureBlock`, which already translates the complete local inventory into the compact wire shape. It reuses the canonical list instead of re-deriving posture in the heartbeat or dashboard. The 16-key clamp is a transport bound, not a posture heuristic. Display belongs in the existing machine record because `/pool` is the fleet heartbeat consumer and that record already renders the machine’s guard counts.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

The new heartbeat members can only describe already-derived state. Neither the store nor the dashboard can enable, disable, suppress, alarm, notify, place, or authorize anything from them. Existing authorities receive byte-for-byte equivalent inputs because the probe does not read the new members.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. Membership comes from the existing closed list. The number 16 is an explicit transport ceiling over a deterministic sample, paired with an uncapped count; it does not decide whether protection is healthy.

---

## 5. Interactions

- **Shadowing:** none. Posture classification and summary assembly complete before heartbeat projection. The dashboard reads the result after pool ingestion.
- **Double-fire:** structurally prevented. No new call to `emitAttention`, `createAttentionItem`, notification code, or probe evaluator exists. The peer refusal test presents `errored: 1` together with the new key and obtains exactly one existing acute episode and no load-bearing episode.
- **Races:** no new concurrent state is introduced. `MachinePoolRegistry` already replaces its in-memory posture on each beat; the store’s existing synchronous write-on-change path receives two more compared fields.
- **Feedback loops:** none. `/pool` and the Machines glance are read surfaces. The displayed value is never fed into guard evaluation, machine health, routing, placement, or messaging.
- **Compatibility:** the wire fields are optional for old persisted records and old peers. The renderer falls back to the key-array length when a transitional payload has keys but no count and refuses to display a count smaller than the keys actually present.
- **Payload:** the new list is sorted and sliced to 16. The full count is one number; there is no unbounded free text.

---

## 6. External surfaces

Authenticated `/pool` callers receive two additive optional members inside each machine’s existing `guardPosture` block. The Machines dashboard displays them in the existing machine detail record. No response status, authentication rule, peer URL, external-service call, Telegram/Slack message, attention item, or notification changes.

The persisted `guard-posture-peers.json` may contain the two additive fields after an upgraded heartbeat. Old records deserialize because the fields are optional; rollback ignores the extra JSON members.

No operator-facing action is added. The surface is diagnostic only: there is no grant, approval, destructive operation, or laptop-only workflow.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** There is no action. The new answer appears directly in the already-open machine record beside its other safety-check facts; it is not hidden behind another toggle.
2. **Zero raw internals as primary content?** The plain label is “Load-bearing protection unproven.” Guard keys are supporting identifiers after the human-readable count, not headline or tile content.
3. **Destructive actions de-emphasized?** No destructive or constructive control is added.
4. **Plain language + phone width?** The label is plain language and the existing record value style uses `overflow-wrap: anywhere`, so long guard keys wrap instead of forcing horizontal scroll. The change adds no table or fixed-width element. Unit, integration, and end-to-end DOM tests open the real Layer-3 record and require the count/key text; the existing phone-width record layout and tap targets are unchanged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: replicated via heartbeat.** Each machine derives its own machine-local guard truth and includes the bounded projection in its normal capacity heartbeat. `MachinePoolRegistry` receives it, `GuardPostureStore` retains the last known value for a dark peer, `GET /pool` returns it, and the Machines glance displays it with that machine’s identity.

It emits no user-facing notice, so one-voice gating is not needed. It adds no new store or topic-bound state; it extends the existing per-machine posture record. It generates no URLs. The peer probe deliberately ignores the field, preventing a per-machine multiplication of notices.

---

## 8. Rollback cost

Revert the two wire members, producer projection, semantic comparison, dashboard row, and tests, then ship a patch. Existing persisted JSON may retain unknown additive members, which older code ignores. There is no schema migration, database cleanup, agent reset, user notification, or classification repair.

---

## Conclusion

The change completes the second read surface without creating a second behavioral system. The heartbeat is explicitly bounded, the count preserves truth under truncation, the fleet reader displays the field, and all existing authority paths remain unchanged. Refusal-first tests pin the errored guard’s exclusion from `loadBearingGapKeys`, inclusion in the new list, exactly one existing anomaly with no notification track, the 16-key ceiling, persistence, real `/pool` exposure, and end-to-end display.

---

## Second-pass review (required: guard-related change)

**Reviewer:** `heartbeat_guard_review`

**Independent read of the artifact:** Concur with the review: the errored load-bearing guard remains outside `loadBearingGapKeys`; the heartbeat adds only an honest full count plus a deterministic 16-key sorted sample; probe, notification, and machine-health decision paths do not consume the new fields; persistence and the real `/pool` → Machines record path are wired; and the focused unit/integration/e2e suite passes 98/98 with direct refusal assertions for field omission, count dishonesty, cap removal, persistence loss, and display loss. I found no inaccurate artifact claim or adjacent scope drift requiring rework.

---

## Evidence pointers

- Before implementation, the focused unit suite failed three assertions: the heartbeat count/list were absent and the machine record omitted the load-bearing-unproven row.
- Unit: 67/67 across producer, probe refusal, and dashboard drill-down suites.
- Integration: 26/26 across heartbeat persistence, real `/pool`, and Machines glance wiring.
- E2E: 5/5 in the shipped jargon-belt Machines lifecycle.
- Static/build: `npm run lint` and `npm run build` pass without threshold changes.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
