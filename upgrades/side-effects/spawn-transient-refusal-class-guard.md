# Side-Effects Review — transient spawn refusal class guard

**Version / slug:** `spawn-transient-refusal-class-guard`
**Date:** `2026-07-30`
**Author:** `instar-codey`
**Second-pass reviewer:** `Locke (independent Codex review)`

## Summary of the change

`SpawnRequestManager.evaluate()` now delegates to a privately typed `#evaluateGuarded` implementation. Every retryable refusal in that implementation must satisfy a branded result type that only `#refuseTransiently` constructs; the funnel admits the current context to the existing bounded queue before returning the original denial. The spawn path snapshots queued entries without deleting them, passes that snapshot into the prompt, and commits only those exact object identities after `spawnSession` resolves. A real pre-delivery launch rejection therefore leaves the old backlog intact and queues the current request with its launch-start timestamp and sequence. If a later arrival occupied the final global slot during the await, global admission reconciles by sequence and displaces the globally newest later entry for the earlier reservation without exceeding the bound. A per-agent in-flight reservation prevents overlapping launches from delivering one snapshot twice. `tests/unit/spawn-request-manager-class-guard.test.ts` pins the public method to the typed implementation, permits call returns only from the preservation funnel, forbids branded casts elsewhere in the class, exercises an `any`-helper mutation, and checks the production server constructs, starts, routes, exposes, and disposes this exact manager.

Files touched:

- `src/messaging/SpawnRequestManager.ts` — typed preservation funnel, transactional queue snapshot/commit, sequence reservation, and per-agent in-flight serialization.
- `tests/unit/spawn-request-manager.test.ts` — real pre-delivery failure, ordering/TTL, overlap, final-global-slot reconciliation, and zero-cap regressions.
- `tests/unit/spawn-request-manager-class-guard.test.ts` — class-wide AST ratchet and production-wiring proof.
- `docs/specs/spawn-transient-refusal-class-guard.eli16.md` — Tier-1 plain-English review surface.
- `upgrades/next/spawn-transient-refusal-class-guard.md` — release fragment.

## Decision-point inventory

- `SpawnRequestManager.evaluate()` admission checks — **pass-through** — cooldown, session cap, memory pressure, subscription quota, and launch-failure predicates/verdicts are unchanged.
- `#refuseTransiently()` — **add** — mechanical postcondition for an already-made retryable decision; it has no authority to classify a request or relax a gate.
- `#spawnInflightByAgent` — **add** — a mechanical per-agent mutex after all admission decisions, preventing duplicate delivery without changing who may eventually spawn.
- queue snapshot commit after `spawnSession` resolution — **modify** — removes only payloads whose prompt has been reported delivered.
- degraded queue cap normalization — **modify** — stale constructor value zero is floored to one and new runtime updates reject zero, preventing a non-terminating overflow loop.

---

## 1. Over-block

No admission authority changes. Every pre-existing refusal returns the same `approved`, `reason`, and `retryAfterMs` values as before. An overlapping same-agent launch is now serialized with a retryable refusal; without this mechanical lock, cooldown zero allowed both attempts to deliver the same queued instructions.

The existing global/per-agent queue bounds still apply. Ordinary new arrivals at the global cap are refused and set the existing truncation marker. The only reconciliation case is a payload stamped earlier but admitted later because its launch was in flight: it displaces the globally newest later entry, marks that entry's agent truncated, and leaves total depth unchanged. This preserves chronological priority without weakening the ceiling.

---

## 2. Under-block

This guard defines “retryable” mechanically as a `SpawnResult` carrying `retryAfterMs`. The private brand and guarded return union make a new retryable result fail type-checking unless it uses the funnel. The AST half constrains every guarded return to either a final literal result or a direct `this.#refuseTransiently` call, forbids assertions inside the guarded method, and permits branded casts across the class only at the funnel's single construction point. A mutation test injects an `any`-returning private helper and proves the ratchet rejects it. A future refusal that is conceptually temporary and omits `retryAfterMs` would still be treated as permanent; reviewers must ensure temporary decisions expose retry semantics.

The queue remains process-local and a server restart can still lose admitted entries. That is tracked as `CMT-1112`; the current change closes branch drift, not persistence. <!-- tracked: CMT-1112 -->

The remote sender is not yet given an end-to-end receipt distinguishing “spawned now” from “accepted into retry queue” or “queue cap refused admission.” That contract correction is tracked as `CMT-1111`. <!-- tracked: CMT-1111 -->

---

## 3. Level-of-abstraction fit

The invariant belongs inside `SpawnRequestManager`, the one class that owns all five retryable outcomes and the queue they must feed. Putting it in `ThreadlineRouter` would require the router to reinterpret reason strings and duplicate admission knowledge. Putting it in each detector repeats the defect: another branch can forget.

The compiler brand is intentionally class-scoped and is the non-bypassable enforcement. The AST ratchet pins the production method shape and blocks casts around that brand, while ordinary behavioral tests prove the funnel actually preserves and later drains content.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

Cooldown, session-count, memory-pressure, subscription-quota, and launch-result producers remain the existing authorities. `#refuseTransiently` consumes their already-final denial and performs deterministic storage bookkeeping. The AST test is a development-time structural validator, not a runtime message classifier and not a competing authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic appears at a competing-signals decision point. “A result containing `retryAfterMs` must use the preservation funnel” is an enumerable transport invariant, analogous to an idempotency-key requirement. It does not judge message meaning, urgency, or user intent.

---

## 5. Interactions

- **Shadowing:** the funnel runs only after an existing authority has denied. It cannot prevent later checks from running because those branches already returned at the same points.
- **Double-fire:** pre-spawn branches queue the current payload once through the funnel. The launch branch snapshots existing entries without removing them; success commits the snapshot, while rejection queues only the current payload. The per-agent in-flight set prevents a second launch from snapshotting the same backlog before the first commits.
- **Races:** `spawnSession` is awaited, so another inbound request can enqueue while launch is in flight. The old destructive drain temporarily freed capacity and could lose ordering. The new queue snapshot retains old entries in place; success removes snapshot entries by object identity, leaving concurrently appended entries even when their content/hash matches. On failure, the reserved current payload is inserted by its launch-start sequence, ahead of later arrivals.
- **TTL:** failed launch does not recreate backlog entries. The current request receives its `receivedAt` timestamp before the launch await, so a slow failure cannot extend its ten-minute lifetime.
- **Global capacity:** a reserved payload is not counted while already present in an in-flight launch prompt. If its launch fails after a later arrival fills the last slot, sequence reconciliation evicts only the globally newest later entry and admits the earlier reservation. This is bounded oldest-first retention, not extra capacity.
- **Truncation:** a successful snapshot commit clears the truncation marker only if no entries remain. A concurrent remainder retains its marker.
- **Drain loop:** `runTick` already prevents overlapping ticks with `#tickInflight`. The production `onDrainReady` callback calls the same guarded `evaluate()` method.
- **Zero cap:** legacy `degradedMaxQueuedPerAgent: 0` previously made `while (queue.length >= cap)` infinite even for an empty queue. Effective admission now floors it to one, and live config updates reject zero.

---

## 6. External surfaces

Other agents observe no new response fields and no changed denial copy. The visible improvement is behavioral: a message refused under a temporary condition remains available for retry, including when the worker process itself failed before delivery.

No endpoint, configuration key, dashboard control, URL, database, or external service integration is added. Queue timing remains dependent on existing cooldown and drain cadence.

No operator-facing actions are introduced.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Spawn admission and the pending queue belong to the machine that received the inbound dispatch and is responsible for starting the local worker. This change neither creates nor changes topic placement, replicated records, or pool routing. The class guard applies identically in every installed copy.

The process-local queue is not durable across restart; that separate persistence gap is tracked as `CMT-1112`. <!-- tracked: CMT-1112 -->

This change emits no user-facing notices, creates no URLs, and adds no durable state that could strand during topic transfer.

---

## 8. Rollback cost

- **Hot-fix release:** revert the single code/test/docs commit and ship the next patch.
- **Data migration:** none.
- **Agent state repair:** none; the queue schema and persisted state are unchanged.
- **User visibility:** rollback would reopen the pre-delivery spawn-failure loss and remove the structural CI ratchet.

---

## Conclusion

The side-effects pass changed the initial implementation materially. Re-enqueueing drained messages would have reset their TTL and reordered them behind messages arriving during the launch await. The first independent pass then found four further gaps: overlapping same-agent launches could duplicate the snapshot; the current failed payload could sort behind a later arrival; a zero degraded cap could loop forever; and a raw AST text rule could be bypassed. The second independent pass found two more: the earlier reservation could still lose to a later arrival at the global cap, and an `any`-returning helper outside the guarded method could evade the branded boundary. The final design adds per-agent serialization, launch-start sequence/TTL reservation, chronological global-cap reconciliation, a one-slot degraded floor, and a compiler-enforced private brand with whole-class cast and guarded-return constraints. Existing admission authorities remain intact. Independent re-review concurs; this is clear to ship.

---

## Second-pass review

**Reviewer:** Locke
**First verdict:** CONCERN

The first pass requested four concrete repairs: serialize same-agent launches; preserve the current payload's launch-start order and TTL across failure; make zero degraded capacity terminate safely; and replace the bypassable raw AST rule with a compiler-enforced return boundary plus stronger production wiring assertions. All four were reproduced with tests that failed against the then-current implementation before the fixes were written.

**Second verdict:** CONCERN

The re-review found a cap-one race where a later in-flight refusal could occupy the sole global slot before the earlier launch failed, causing the earlier reservation to be dropped. It also demonstrated that an `any`-returning helper outside `#evaluateGuarded` could evade the first AST rule. Both exact reproductions failed before their repairs: the recovered prompt contained only the later payload, and the mutation produced zero violations. The implementation now reconciles full global capacity by sequence and the ratchet constrains guarded return shapes plus branded casts across the class.

**Final verdict:** CONCUR

Locke re-read the final diff and this artifact, reran the focused 89-test suite, and confirmed both later concerns plus all four earlier concerns are closed. The production constructor, `ThreadlineRouter`/`AgentServer` handoffs, start, and dispose links are real and structurally pinned. No actionable correctness concern remains.

---

## Evidence pointers

- Initial failing-before runtime result: expected queue depth `2`, received `0`.
- Initial failing-before class ratchet: direct retryable result construction at five lines in the unfixed class.
- Reviewer-strengthened failing-before result: four failures — ordering, overlapping admission, zero-cap effective value, and missing typed guard.
- Re-review-strengthened failing-before result: two failures — final-slot loss of the earlier reservation and undetected `any`-helper indirection.
- Fixed focused run: 89/89.
- Adjacent quota/router/admission/integration run: 166/166.
- Full TypeScript and 33-step lint chain: pass after reviewer repairs.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in hand-written TypeScript, not an LLM prompt, hook, config, skill, or standards text, and this change does not add a new self-triggered controller. The existing bounded drain controller is unchanged. Separately, this PR itself supplies the missing runtime/CI class guard: `#refuseTransiently` plus `tests/unit/spawn-request-manager-class-guard.test.ts` catch direct retryable returns, indirect helper returns, and branded casts outside the one construction point.
