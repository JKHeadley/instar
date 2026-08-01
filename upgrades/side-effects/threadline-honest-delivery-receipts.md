# Side-Effects Review — Honest Threadline delivery receipts

**Version / slug:** `threadline-honest-delivery-receipts`
**Date:** `2026-07-30`
**Author:** `instar-codey`
**Second-pass reviewer:** `three independent reviewers — all concur`

## Summary of the change

This change separates local submission, receiver acceptance, and proven processing across `SpawnRequestManager`, `ThreadlineRouter`, the two receiver accept boundaries, the local/relay send route, the MCP HTTP client, and the MCP result. It narrows the production threadless fallback so a newly honest `handled:false` refusal cannot cause a second router invocation. Second-pass review also made content dedup admission transactional: a rejected or thrown inbox admission releases its reservation, while a duplicate is suppressed without claiming acceptance. Pressure, autonomy, trust, quota, and spawn-admission verdicts remain unchanged.

## Decision-point inventory

- `SpawnRequestManager.#refuseTransiently` — modify — reports whether this exact refused payload entered the bounded retry queue.
- `ThreadlineRouter.handleInboundMessage` result exits — modify — separates handled, accepted, delivered, and queued without changing the underlying gate verdict.
- `/messages/relay-agent` and `/threadline/messages/receive` accept boundaries — modify — explicitly report accepted but not delivered before background processing.
- `/threadline/relay-send` result mapping — modify — preserves explicit receipt facts and uses concrete legacy completion signals only.
- `ThreadlineMCPServer` send result — modify — stops defaulting successful transport to delivered.
- Relay-ingest threadless fallback — modify — retries only when no thread was resolved, preventing double handling after a refusal.
- Relay content dedup — modify — reserves before inbox admission, rolls back on rejection/throw, and reports suppressed duplicates conservatively.

---

## 1. Over-block

The change touches two deterministic block/allow surfaces. The threadless fallback no longer retries an unhandled result when the router already resolved a thread; the legitimate excluded input is precisely a refusal that would otherwise be double-fired. Content dedup still suppresses an identical sender/thread/content triple within 60 seconds, so a deliberate verbatim resend inside that window remains an accepted pre-existing tradeoff. This patch makes that suppression explicit and prevents a failed first admission from poisoning the retry.

---

## 2. Under-block

This patch cannot prove eventual processing after an asynchronous accept boundary unless a later reply or existing receipt path supplies evidence. A receiver can accept work and then restart before in-memory queued work is drained; that durability gap is tracked separately by CMT-1112. A first request that was durably admitted but failed during later processing can cause an equivalent retry to be suppressed for the bounded 60-second dedup window. Mixed-version receivers can omit `accepted`; an updated sender treats successful non-held, non-error legacy responses as accepted but never infers delivery without concrete evidence.

---

## 3. Level-of-abstraction fit

The queue-admission boolean is a low-level fact produced by the component that owns the queue. The router composes that fact with its actual processing outcome, and the MCP surface reports the composed facts. `handled` also drives deterministic retry/recovery structure, so the production fallback was reviewed and narrowed at that consumer rather than treated as display-only. Dedup remains an enumerable idempotency invariant, not conversational judgment.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

**Applicable posture:** deterministic structural authority over enumerable invariants, which the template's four conversational-gate choices do not name. The fallback may retry only when no thread was resolved, and dedup may suppress only the existing exact normalized triple within its fixed window. Neither interprets intent or competing conversational signals, so an LLM-backed smart gate would be the wrong abstraction.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic exists at a competing-signals decision point. “A live handler processed this message,” “the receiver accepted it,” “the relay socket was merely submitted to,” and “this payload entered the queue” are enumerable state facts. The compatibility fallback is deliberately one-way: absent explicit proof may imply acceptance only after successful non-error legacy transport, but never delivery.

---

## 5. Interactions

- **Shadowing:** Reporting happens after existing trust, autonomy, lease, quota, and pressure checks. Dedup still runs before inbox admission to reserve against concurrent duplicates, but now rolls that reservation back if admission rejects or throws.
- **Double-fire:** Changing a refusal to `handled:false` exposed the production threadless fallback as a possible second invocation. The fallback now also requires no resolved thread, and a fail-first wiring regression pins that condition.
- **Races:** The local `/messages/relay-agent` endpoint acknowledges after durable `MessageRouter` inbox admission but before background spawn. The signed `/threadline/messages/receive` endpoint acknowledges authenticated in-process responsibility before its optional canonical write and background handoff; its pre-existing crash-before-handoff window remains and is not mislabeled durable custody. Both say only `accepted:true, delivered:false`, avoiding the historical timeout/retry race. A concurrent duplicate sees a conservative unaccepted suppression result rather than fabricated acceptance.
- **Feedback loops:** The immediate MCP result does not feed the router. Existing later reply and acknowledgement systems may strengthen delivery evidence, but no new retry loop is introduced.

---

## 6. External surfaces

Other agents now see separate `accepted` and `delivered` fields. Existing success, thread, reply, held, note, and path fields remain. Relay socket submission is explicitly unconfirmed (`accepted:false, delivered:false`); asynchronous receiver acceptance is `accepted:true, delivered:false`. Suppression is conclusively processed, while duplicate suppression claims neither fact. The exported result fields remain optional for source compatibility with older external fixtures, while the built-in router returns both. No external service, persistent schema, URL, credential, or operator action changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated behavior** — the semantics travel with the installed Instar package on each machine, while the wire format is additive for mixed-version peers. An updated sender treats an older receiver conservatively. The reverse direction is limited: an old sender ignores the new fields and can retain its historical false `delivered:true` default until that sending machine upgrades. There is no new durable state to replicate or proxy. This change emits no user-facing notices, generates no URLs, and holds no new state that can strand during topic transfer.

---

## 8. Rollback cost

Pure code and response-semantics change: revert and ship a patch. There is no data migration, state repair, or cleanup. Rollback would restore the false-positive `delivered:true` behavior while propagation completes, which is the only user-visible regression.

---

## Conclusion

The reviews found and changed six interactions: the threadless double-fire fallback, queued warm-refusal double admission, unacknowledged relay submission, poisoned dedup reservations, legacy error acceptance, and receipt omissions on suppression/no-router success branches. Each behavioral correction has a fail-first regression. Fast receiver acknowledgement remains intact, the exported type stays source-compatible, and authoritative A2A documentation now uses the new meanings. All three independent reviewers concur after re-review.

---

## Second-pass review (if required)

**Reviewer:** correctness, production-wiring, and side-effects reviewers
**Independent read of the artifact: concur**

- Relay socket submission was falsely called accepted; it is now unconfirmed until reply evidence.
- Dedup could retain a rejected/throwing reservation; both failure modes now release it.
- Legacy explicit error outcomes could infer acceptance; the fallback now excludes them.
- Suppression and no-router success branches omitted receipt fields; both are explicit.
- A queued warm refusal fell through and queued the same inbound again on the cold path; it now returns after one admission.
- Mixed-version directionality, deterministic retry/dedup authority, type compatibility, and A2A documentation were corrected.

All reviewers independently verified the corrections and concurred.

---

## Evidence pointers

- New receipt and wiring regressions were run against the unfixed source first; the focused unfixed run exposed missing queue admission, false handled/delivered results, lost HTTP fields, the unsafe threadless fallback, and the omitted held-path acceptance result.
- Reviewer-added regressions failed before their fixes for unconfirmed relay acceptance, rejected and thrown dedup admission, legacy error acceptance, and omitted receiver-branch fields.
- Pre-hardening affected and adjacent verification: 364/364 unit/integration assertions plus 66/66 E2E assertions.
- Final post-hardening affected verification: 341/341 assertions across all 15 changed receipt, wiring, integration, and E2E files; the no-silent-fallback ratchet is also at its exact 495 baseline (5/5 assertions).
- Full lint chain, TypeScript typecheck, production build, and `git diff --check`: pass.
- A broad local sweep was interrupted after it exposed unrelated session-launch fixture/config leakage and tmux timing failures in untouched files. Those signals are recorded rather than mislabeled green; authoritative sharded CI remains the merge gate.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no added or modified self-triggered controller — not applicable.
