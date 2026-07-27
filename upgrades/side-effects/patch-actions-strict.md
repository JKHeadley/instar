# Side-Effects Review - PATCH actions strict body

**Version / slug:** `patch-actions-strict`
**Date:** `2026-07-26`
**Author:** `Codex`
**Second-pass reviewer:** `not required`

## Summary of the change

This change tightens `PATCH /evolution/actions/:id` in `src/server/routes.ts` so the route refuses request bodies containing fields outside the documented patch contract, currently `status` and `resolution`. It also rejects empty usable updates, validates the type and allowed values of supported fields before mutation, and passes `EvolutionManager.updateAction` only the fields actually present. The integration coverage in `tests/integration/evolution-actions-patch-route.test.ts` asserts both responses and stored records so the old "ok but discarded" behavior is caught.

## Decision-point inventory

- `PATCH /evolution/actions/:id` body validation in `src/server/routes.ts` - modify - deterministic API schema gate now rejects unsupported fields and empty usable updates before any store write.
- `PATCH /evolution/actions/:id` supported field validation in `src/server/routes.ts` - modify - `status` and `resolution` are type-checked before constructing the update object.
- `EvolutionManager.updateAction` call site in `src/server/routes.ts` - modify - receives only validated, explicitly present update keys instead of destructured possibly-undefined values.
- Standby-write reconciliation via `refuseInadmissibleWrite(req, res)` - pass-through - still runs after body validation and before mutation, preserving the existing admission order.

---

## 1. Over-block

The intentional over-block is that callers sending any extra field now receive `400` where they previously received `200`. Concrete examples: `{ "title": "Corrected title" }`, `{ "description": "Retract the false claim" }`, and `{ "status": "completed", "title": "Corrected title" }` are now rejected because `title` and `description` are not supported by this patch route. A caller that used extra fields as harmless client metadata in the same JSON body also gets a `400`; that caller must stop sending those fields or use a separate supported surface. This is acceptable because the old behavior silently ignored those fields while claiming success.

---

## 2. Under-block

This still does not add support for changing action title, description, priority, tags, due date, or source. It also does not validate semantic transitions such as whether moving from `cancelled` back to `completed` is appropriate. A request with a syntactically valid but poor resolution like `{ "resolution": "done" }` still passes because the route only enforces a non-empty string, not quality or evidence. A request with `{ "status": "completed" }` and no resolution still passes, matching the existing documented surface.

---

## 3. Level-of-abstraction fit

This is at the route schema layer, which is the right layer for an enumerable API contract. The route knows which fields it supports and can reject any other key before the persistence layer sees the request. This should not be an LLM authority or a higher-level intent gate because there are no competing contextual signals to weigh; the question is simply whether the JSON body matches the route's declared write surface. It still uses the existing lower-level `EvolutionManager.updateAction` primitive for the actual mutation instead of reimplementing persistence.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No - this change produces a signal consumed by an existing smart gate.
- [ ] No - this change has no block/allow surface.
- [ ] Yes - but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Warning: Yes, with brittle logic - STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

None of the predefined checkboxes exactly names deterministic API schema validation. The change does hold reject authority, but not over a brittle inferred signal. The supported field set is a finite invariant owned by the route, so refusing non-contract keys is ordinary request validation rather than a competing-signals judgment point. No signal-vs-authority issue identified.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?**

No new static heuristic at a competing-signals decision point. The body shape is enumerable: `status` and `resolution` are the only supported fields for this route. There is no live conflict between evidence, liveness, ownership, urgency, or operator intent that needs an arbiter.

---

## 5. Interactions

**Shadowing:** The new schema validation runs before `refuseInadmissibleWrite`. It can shadow the standby-write reconciliation check for malformed requests, but only before any mutation and only for requests that the route should not admit. Valid requests still reach the existing reconciliation gate in the same relative position before `updateAction`.

**Double-fire:** No issue identified. The new route validation returns one HTTP response and performs no side effect. It cannot double-submit an action update or duplicate a reconciliation event.

**Races:** No issue identified. The change does not introduce shared state or asynchronous work. The same list-then-update pattern for the class-review completion side effect remains unchanged.

**Feedback loops:** No issue identified. The only new feedback is a synchronous `400` response naming unsupported fields, which helps callers correct their request rather than feeding another automatic retry loop.

---

## 6. External surfaces

This changes the HTTP API response for malformed `PATCH /evolution/actions/:id` requests. Other agents or scripts on the same machine that send unsupported fields now see `400` instead of `200`. Other users of the install base get the stricter behavior after upgrade. There is no direct Telegram, Slack, GitHub, Cloudflare, or other external-service call. Persistent state changes are reduced: unsupported writes now leave state untouched and visibly fail, where they previously left state untouched while claiming success. No timing or runtime condition is introduced.

**Operator surface (Mobile-Complete Operator Actions):** No operator-facing action is added. The change touches an existing HTTP route, not a dashboard form or approval page, so no phone-completable operator surface is required.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface - not applicable. This change does not touch dashboard markup, approval pages, grant/revoke forms, or secret-drop forms.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** - the route validates a request body before mutating the local evolution store for the agent instance handling the request. The validation rule is code-level behavior that ships identically to every machine, but the action records themselves remain the existing local evolution state. The change emits no user-facing notices, so one-voice gating is not needed. It holds no new durable state, so there is nothing new to strand on topic transfer. It generates no URLs, so there is no cross-machine link survival concern.

---

## 8. Rollback cost

**Hot-fix release:** Revert the route validation and test additions, then ship a patch release.

**Data migration:** No data migration. The change creates no new files in runtime state and changes no schema.

**Agent state repair:** No agent state repair is required. If a caller hit the new `400`, its prior ignored write still did not mutate state; the repair is to resend a supported patch or add a real route for the intended field.

**User visibility:** During rollback propagation, malformed callers would go back to receiving `200` for ignored fields, which is the original defect. Documented callers sending only `status` and `resolution` should not notice rollback either way.

---

## Conclusion

The review identifies one intentional compatibility break: callers sending extra unsupported fields now fail loudly. That is the point of the change because the previous behavior created false evidence of a correction. The change is small, route-local, deterministic, and does not add new persistent state or external side effects. Clear to ship with the explicit release note that extra fields now receive `400`.

---

## Second-pass review (if required)

**Reviewer:** `not required`
**Independent read of the artifact:** `concur`

Tier 1 does not require a second-pass reviewer for this route-local schema hardening.

---

## Evidence pointers

- `docs/specs/patch-actions-strict.eli16.md`
- `tests/integration/evolution-actions-patch-route.test.ts`
- `npx tsc --noEmit`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect - not applicable.
