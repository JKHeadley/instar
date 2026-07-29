# Side-Effects Review — Require follow-through enrollment or explicit opt-out

**Version / slug:** `require-followthrough-enrollment`
**Date:** `2026-07-28`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

The two HTTP creation boundaries, `POST /commitments` and
`POST /evolution/actions`, now refuse the previously valid third state in which a
new durable record had neither a follow-through schedule nor an explicit reason
for having no schedule. A commitment must either enroll in PromiseBeacon with a
valid deadline or persist `followThroughOptOutReason`; an evolution action must
either carry a valid `dueBy` or persist the same reason field. The reason is
threaded through the existing commitment and action persistence/replication
paths. Shipped guidance, one production job caller, and migration parity are
updated so existing agents learn and send the accepted shapes. Existing records,
resurfacing behavior, and user notifications are unchanged.

## Decision-point inventory

- `src/server/routes.ts` — **modify** — the commitment creation boundary accepts
  exactly one of PromiseBeacon enrollment plus a deadline or a stored opt-out
  reason.
- `src/server/routes.ts` — **modify** — the evolution-action creation boundary
  accepts exactly one of a valid `dueBy` timestamp or a stored opt-out reason.
- `src/core/CommitmentsSync.ts` — **pass-through** — the new commitment free-text
  field uses the existing replicated-state redaction authority.
- `src/core/EvolutionActionsReplicatedStore.ts` — **pass-through** — the new
  action free-text field uses the existing receive clamp, emit clamp, origin
  materialization, and untrusted-render sanitization boundaries.
- `src/core/PostUpdateMigrator.ts` — **modify** — exact prior shipped commitment
  guidance is upgraded to an enrolled payload; customized guidance is not
  guessed at or rewritten.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No unintended legitimate shape was identified. The change deliberately rejects
callers that relied on omission, including `beaconEnabled: false` with no reason,
a deadline without `beaconEnabled: true`, an action with neither `dueBy` nor a
reason, and a commitment carrying only `checkInAt`. `checkInAt` is intentionally
not treated as agent follow-through because it belongs to the separate
user-reminder boundary. A reason longer than 2,000 characters is rejected; this
is the existing bounded-free-text posture at an API edge, and a caller can state
the operational reason within that bound.

The caller audit found and repaired the shipped commitment-detection job and the
stall-matrix job. Their previous payloads would otherwise have become legitimate
production over-blocks after this boundary changed.

---

## 2. Under-block

**What failure modes does this still miss?**

The invariant is enforced at the two named HTTP creation chokepoints. Trusted
in-process code can still call `CommitmentTracker.record()` or
`EvolutionManager.addAction()` directly without these fields; changing those
shared internal constructors would alter many unrelated lifecycle paths and is
not part of this API-boundary change. Production callers of the changed HTTP
routes were audited and updated.

Existing unenrolled records are intentionally untouched. This change prevents
new HTTP-created omissions; it does not backfill, resurface, or adjudicate the
existing stock. An explicit opt-out reason can also be factually weak or
dishonest: the boundary guarantees an auditable choice was made, not that prose
alone is true.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. These are hard-invariant structural validators at the API edge. The rule is
fully enumerable: exactly one of two typed shapes is present. The route owns
write admission and is the last shared boundary before each durable store, so it
can refuse without mutation and without duplicating policy in the overdue
checker or PromiseBeacon. The existing persistence and replication layers remain
data carriers rather than parallel authorities.

The resolver, reminder jobs, and resurfacing mechanisms are not changed. Moving
the invariant into them would be too late: they can only process records that
were enrolled at creation.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

None of the four generic boxes precisely describes this exception: the change is
a deterministic hard-invariant validator, explicitly exempted by
`docs/signal-vs-authority.md`. It does hold HTTP 400 authority, but it judges no
message meaning or agent intent. The accepted domain is enumerable from typed
fields, the refusal includes the missing choice, and the same payload always
produces the same result. No regex, confidence score, or low-context semantic
detector has been promoted to authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic was added at a competing-signals decision point. The route
does not weigh liveness, recency, ownership, urgency, or prose meaning. It
enforces the enumerable record invariant that a follow-through mechanism or an
auditable opt-out exists.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** action validation runs before standby write admission and store
  mutation. Commitment validation runs before conversation binding and tracker
  mutation, while the existing class-review admission remains earlier and may
  refuse independently. No accepted record skips an existing admission check.
- **Double-fire:** no new timer, checker, beacon, reminder, or notification is
  added. Enrolled commitments continue into the one existing PromiseBeacon;
  opted-out commitments are explicitly stored with `beaconEnabled: false`.
- **Races:** validation is synchronous and completes before the first mutable
  store operation. It introduces no shared mutable state.
- **Feedback loops:** the persisted opt-out field is descriptive data only. It
  does not feed a scheduler. The existing overdue checker and PromiseBeacon
  continue reading only `dueBy` and beacon enrollment respectively.
- **Migration parity:** the migrator rewrites only the exact previously shipped
  bare commitment payload. Customized instructions are left untouched. Fresh
  templates and the generated commitment-detection job teach the same XOR
  contract.
- **Replication/security:** commitment opt-out prose joins the existing
  credential-redaction field set. Evolution-action opt-out prose uses the
  replicated store's existing length clamp and untrusted rendering sanitizer.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

Yes. Direct API callers now receive HTTP 400 for a bare creation payload and must
send one accepted follow-through choice. Successful responses and list/read
shapes gain an optional `followThroughOptOutReason` field when that choice was
used. The reason persists across restart and replication.

No Telegram, Slack, Attention, email, dashboard, or other user-notification path
changes. Tests assert zero Attention writes for both accepted and refused
creation. No operator action, approval surface, external-system write, URL, or
timing dependency is introduced.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Commitment reasons travel through `CommitmentsSync` with the same
free-text credential redaction as the other commitment prose. Evolution-action
reasons travel through `EvolutionActionsReplicatedStore`, including receive
clamping, emit clamping, own-origin materialization, and sanitized foreign
rendering.

The creation decision is machine-independent because it depends only on the
request shape. The feature emits no user-facing notice, so one-voice gating is
not needed. It holds durable state, but that state uses the existing replicated
commitment/action paths and is not stranded by topic transfer. It generates no
URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the route, model, replication-field, guidance, and
  migration changes and ship a patch.
- **Data migration:** none required. Older code ignores the additive reason
  field. Records created with a real deadline remain valid under the prior
  implementation.
- **Agent state repair:** none required. Opted-out commitment rows retain
  `beaconEnabled: false`; reverting merely makes future omission possible again.
- **User visibility:** direct API integrations would stop receiving the new 400
  after rollback. No user notification behavior changes during propagation.

---

## Conclusion

The review found the main compatibility risk at shipped callers, not in the
validator itself. That produced concrete repairs to the obsolete `dueDate`
commitment-detection payload, the stall-matrix payload, fresh templates, and the
exact prior guidance migration. The final change remains bounded to future HTTP
creation, with no backfill, resurfacer, deletion, or notification behavior. The
deterministic API-edge invariant complies with Signal vs Authority and is clear
to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

This change does not touch outbound/inbound messaging decisions, dispatch,
session lifecycle, compaction, trust, coherence, or a self-triggered controller.

---

## Evidence pointers

- `tests/unit/commitment-routes.test.ts`
- `tests/integration/write-admission-routes.test.ts`
- `tests/unit/CommitmentsSync.test.ts`
- `tests/unit/EvolutionActionsReplicatedStore.test.ts`
- `tests/unit/followthrough-enrollment-guidance.test.ts`
- `upgrades/next/require-followthrough-enrollment.md`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: prompt-parser-contract-drift`, `closure: guard`,
`guardEvidence: { enforcementType: ratchet, citation:
tests/unit/followthrough-enrollment-guidance.test.ts, howCaught: the shipped
commitment-detection prompt is rendered and asserted to use the accepted
dueBy-or-followThroughOptOutReason contract and to contain no obsolete dueDate
field, so the prompt cannot again teach a payload its consuming route ignores or
refuses }`.
