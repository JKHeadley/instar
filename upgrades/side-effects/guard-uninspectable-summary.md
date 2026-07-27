# Side-Effects Review — Guard load-bearing inspectability summary

**Version / slug:** `guard-uninspectable-summary`
**Date:** `2026-07-25`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `guard_uninspectable_review`

## Summary of the change

`src/monitoring/guardPostureView.ts` adds one field to `GuardsSummary`: `loadBearingUninspectableKeys`. `buildGuardInventory` fills it when a load-bearing row retains one of four existing effective postures: `missing`, `errored`, `on-stale`, or `off-runtime-divergent`. The existing row classification, `loadBearingGap` flag, `loadBearingGapKeys`, heartbeat projection, and `GuardPostureProbe` anomaly logic are unchanged. Because `GET /guards` returns `inventory.summary` directly, the additive field reaches the authenticated local and pool read surfaces without a route-specific copy step.

## Decision-point inventory

No block/allow or actuation decision point is added or modified. The change adds a read-only projection over already-derived guard rows. Existing guard classification and probe alert decisions are passed through unchanged.

- `buildGuardInventory` summary assembly — **modify** — adds an orthogonal completeness list from the closed effective-state vocabulary.
- `GuardPostureProbe` — **pass-through** — consumes guard rows exactly as before; it does not consume the new summary field.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. Every existing request and guard posture remains accepted and classified as before.

---

## 2. Under-block

**What failure modes does this still miss?**

The requested `GET /guards` surface is complete for the named load-bearing inspectability classes. The compact heartbeat posture is a second rendering of the earlier shape: it carries `loadBearingGapKeys` and aggregate loud-class counts, but not keyed load-bearing inspectability. It remains unchanged by instruction; this finding was reported directly to Echo and was neither fixed nor filed.

The new list also deliberately excludes `diverged-pending-restart`, `on-unverified`, and non-load-bearing rows because the requested closed set is exactly `missing`, `errored`, `on-stale`, and `off-runtime-divergent`.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `buildGuardInventory` already owns the canonical `GuardsSummary` derived from the complete row inventory. Computing the list there avoids re-deriving state in `routes.ts`, keeps local and pool responses aligned, and leaves the probe's separate anomaly authority untouched. The membership check is a projection over a closed enum, not a new detector or competing classifier.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

The new field is an additive observation on a read surface. It cannot enable, disable, classify, alert, suppress, or authorize anything. `GuardPostureProbe` remains the anomaly consumer and sees the same rows it saw before.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. The four-member set is the request's closed structural definition of "load-bearing but uninspectable"; it does not resolve conflicting evidence or make a behavioral decision. The normative effective-state precedence table remains unchanged.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. The field is assembled after each row has already been classified.
- **Double-fire:** structurally prevented by leaving `GuardPostureProbe` unchanged. The required errored-row test produces one acute `errored` item and no `guard-posture-loadbearing` item.
- **Races:** none. `buildGuardInventory` is pure over the caller's one-read snapshot and synchronous registry reads.
- **Feedback loops:** none. `GET /guards` does not feed the field back into classification or actuation.
- **Compatibility:** additive JSON field. Consumers that do not know it ignore it; consumers that need completeness can read it.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

Yes: authenticated callers of `GET /guards` and `GET /guards?scope=pool` see `summary.loadBearingUninspectableKeys`. No row fields, response status codes, authentication rules, persistent files, notices, or external-service calls change. The route's timing remains one linear pass over the existing guard rows.

No operator-facing action is added. This is a read-only diagnostic field; there is no new grant, approval, destructive operation, or phone-only workflow.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval page, or operator action surface is changed — not applicable. The API field is machine-readable supporting data, not primary dashboard content.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: proxied-on-read.** Each machine derives its own guard truth from machine-local configuration and runtime getters. `GET /guards?scope=pool` already fetches each known peer's plain `GET /guards` response, so the new summary list travels with that peer's full response and remains attributed to the machine that observed it.

The change emits no user-facing notices, holds no durable state, and generates no URLs. Topic transfer cannot strand it because it is recomputed on every read.

The compact heartbeat posture does not gain this keyed list; that separate rendering was reported to Echo without alteration.

---

## 8. Rollback cost

Pure additive code change. Revert the summary interface member, state set, initializer, and push line, then ship a patch. There is no data migration, persistent state cleanup, agent reset, or user-facing repair. During rollback, callers return to the earlier incomplete summary shape.

---

## Conclusion

The change is narrow and correctly layered: it makes the read model honest without perturbing the classifications and alarms that already own these failure states. Refusal-first coverage pins the absent-field defect, all four exact uninspectable classes, no double-alarm behavior, the real authenticated route, and the live HTTP lifecycle. The heartbeat rendering remains an explicitly reported, unchanged finding under Echo's filing authority.

---

## Second-pass review (if required)

**Reviewer:** `guard_uninspectable_review`
**Independent read of the artifact:** Concur with the review — the only runtime change is an additive summary projection over load-bearing rows in exactly `{missing, errored, on-stale, off-runtime-divergent}`; the precedence/classification and `GuardPostureProbe` code are untouched, the errored case yields one existing acute item and no load-bearing-gap item, and all 54 focused unit/integration/E2E tests pass with no threshold or authority changes.

---

## Evidence pointers

- Refusal evidence: before implementation, `tests/unit/monitoring/guard-posture-probe-loadbearing.test.ts` failed because `loadBearingUninspectableKeys` was absent.
- Unit: 32/32 across `guard-posture-loadbearing` and `guard-posture-probe-loadbearing`; the broader focused unit run was 62/62.
- Integration: 18/18 in `tests/integration/guards-route.test.ts`.
- E2E: 24/24 across `guards-loadbearing-lifecycle` and `guards-endpoint-lifecycle`.
- Static/build: `npm run lint` and `npm run build` passed.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
