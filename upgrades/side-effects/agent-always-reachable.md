# Side-Effects Review — The Agent Is Always Reachable (Increment 1: standard + G2 no-silent-resource-rejection)

**Version / slug:** `agent-always-reachable`
**Date:** `2026-06-26`
**Author:** `echo`
**Second-pass reviewer:** `required (touches resume/session-lifecycle + a "sentinel/gate/watchdog"-class notice path) — appended below`

## Summary of the change

Increment 1 of the `agent-always-reachable` spec: the constitutional standard **"The Agent Is Always Reachable — A Guaranteed Reachability Floor"** (added to `docs/STANDARDS-REGISTRY.md`) plus **G2 — no silent resource rejection**. The concrete fix is a new `pressure-held` notice in `ResumeQueueDrainer`: when a queued session-revival is held by the pressure (calm-ticks) gate AND the oldest READY entry has waited past a bounded window (`pressureHeldNoticeMs`, default ~20min ≈ 2 reaper ticks), the drainer emits ONE plain-English notice through the EXISTING `raiseAggregated` funnel — then suppresses repeats until the gate clears (re-armed per episode). This closes the exact topic-28744 incident: a session was reaped, queued for revival, and held INDEFINITELY and SILENTLY by the pressure gate (made permanent by the now-fixed `os.freemem` false-critical bug, #1287). Files: `src/monitoring/ResumeQueueDrainer.ts` (config field `pressureHeldNoticeMs`, episode flag `pressureHeldNotified`, the gate-block notice), `src/commands/server.ts` (wire `rqCfg.pressureHeldNoticeMs`), `src/core/types.ts` (config type), `tests/unit/resume-queue-drainer.test.ts` (6 G2 tests). G1 (the liveness floor — protect the lifeline from reaping + reserved-lane exempt respawn) is the tracked next increment (CMT-1808), not in this PR.

## Decision-point inventory

- `ResumeQueueDrainer.gateBlock` (calm-ticks pressure hold) — **pass-through** — the notice does NOT change the gate decision; the revival is still held by the unchanged gate. The notice only reports the hold.
- `ResumeQueueDrainer.raiseAggregated` funnel — **pass-through** — reuses the existing system-notice chokepoint (same path as `ttl-expired`); adds one new `kind` (`pressure-held`). No new notifier.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The change adds an observational notice; it never blocks, delays, or rejects any revival, message, or session. The pressure gate's block decision is entirely unchanged — `gateBlock` is called identically and its `'calm-ticks'` return is honored exactly as before.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** The notice is a signal, not a gate. The closest "miss" is a notice that doesn't fire when it should: if `pressureHeldNoticeMs` is set to 0 the notice is disabled (documented), and a dry-run queue is intentionally silent (a fleet of dry-run queues must not page). Both are deliberate and tested. A held revival that has NOT yet waited the full window stays silent until it crosses the window (tested) — that is the intended bounded-debounce, not a miss.

---

## 3. Level-of-abstraction fit

Correct layer. The held-revival fact is ONLY observable inside the drainer's tick loop (it owns the gate verdict + the queue's oldest-ready entry + the clock). Surfacing it from there — rather than from a parallel watcher that would have to re-derive pressure state and re-read the queue — is the right level. It reuses the existing `raiseAggregated` funnel rather than introducing a new notifier (the 2026-06-05 flood was caused by a parallel notice path that dodged the budget; this deliberately rides the budgeted funnel). It is a SIGNAL feeding the existing attention-queue surface, not a new authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate / surface (the attention queue), and has no block/allow surface of its own.

The notice is pure signal. It carries zero blocking authority: it cannot hold, delay, or release a revival. The revival's fate is decided entirely by the unchanged deterministic gates. This is exactly the signal-vs-authority split the principle demands — a brittle/cheap detector (an episode flag + a time comparison) that only ever ADDS a notice, never gates.

---

## 5. Interactions

- **Shadowing:** The notice sits inside the `if (gate)` branch, AFTER the existing `gates-blocked` audit and BEFORE the early `return { blocked: gate }`. It does not shadow any check — it adds a side-effect (one `raiseAggregated` call) on the already-decided block path, then returns the same value as before. Verified the return value is unchanged.
- **Double-fire:** Guarded by the per-episode `pressureHeldNotified` flag — at most ONE notice per held episode. The flag re-arms only when the gate becomes non-pressure (`else` branch) or fully clears (post-gate reset). Tested: three consecutive held ticks emit exactly one notice; a fresh episode after the gate clears emits again.
- **Races:** `pressureHeldNotified` is in-memory, single-threaded with the rest of the tick loop (the drainer's `ticking` re-entrancy guard already serializes ticks). No shared-state race. A server restart mid-episode re-arms (the flag resets to false on construction) → at most one extra notice on the next held tick, which folds harmlessly into the single rolling aggregate item (same tolerance as the existing paused-with-waiting Layer-1 alert).
- **Feedback loops:** None. The notice does not change pressure, the queue, or the gate, so it cannot feed back into its own trigger.
- **Interaction with the 24h `ttl-expired` notice:** an entry can early-notify (`pressure-held`) and LATER expire (`ttl-expired`). Both ride the same aggregate item with distinct `kind`s, so the operator reads a coherent two-stage story ("held under pressure" → later "expired after 24h"), not two unrelated failures. The `pressure-held` window (~20min) is far below the 24h TTL, so ordering is deterministic.

---

## 6. External surfaces

- **Other agents / users:** none directly. This is the agent's own attention-queue surface to its operator.
- **External systems:** Telegram, via the EXISTING `telegram.createAttentionItem` path inside `raiseResumeAggregated` (priority NORMAL, `sourceContext: 'resume-queue'`, subject to the per-source topic-flood guard + bounded-notification budget). No new external call shape.
- **Persistent state:** none new. The episode flag is in-memory by design.
- **Deterministic delivery (G2 MAJOR 5):** the notice routes through `raiseAggregated` → `createAttentionItem` (the attention-queue path), NOT the tone-gated `/telegram/reply` conversational path. This is the load-bearing property: the notice reports memory/CPU pressure, and the tone gate fails CLOSED under exactly that pressure — so a tone-gated notice could be held by the very condition it announces. Riding the attention-queue funnel makes delivery independent of LLM availability. Verified by construction (same funnel as `ttl-expired`, which already delivers under pressure).
- **Operator surface (Mobile-Complete):** no new operator action — the notice is informational, surfaced on the existing attention queue / Telegram, already phone-visible. No PIN-gated or form-class action added.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** This change touches no dashboard renderer/markup, approval page, or grant/revoke/secret-drop form. The notice is plain-English prose on the existing attention queue.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The resume queue is a per-machine durable store (each machine revives its OWN reaped sessions; the queue takes a host-local lock precisely so two machines cannot share its state — see `autonomous-run-outlives-session`). The pressure-held condition is therefore a per-machine truth, and the notice is raised by the machine that holds the held entry. It rides `raiseResumeAggregated` → `createAttentionItem`, which is the same per-machine notice path every other resume-queue notice (`ttl-expired`, paused-with-waiting) already uses — so its multi-machine posture is identical to the surrounding feature and introduces no new cross-machine surface.

- **User-facing notice / one-voice:** it inherits the attention-queue's existing routing + flood guard; it does not bypass them, so no new one-voice concern. (The standard's G1 floor explicitly scopes the lifeline to the lease-HOLDER only; G2's notice is not lease-gated because reporting a held revival on whichever machine holds it is correct — the machine that reaped it is the machine that must revive it.)
- **Durable state on topic transfer:** the in-memory episode flag does not strand (a transferred topic's revival is handled by the destination machine's own queue + the working-set carrier; a lost in-memory flag at most re-notifies once).
- **Generated URLs:** none.

---

## 8. Rollback cost

Trivial. G2 is pure-additive and observe-only:
- **Disable without a deploy:** set `monitoring.resumeQueue.pressureHeldNoticeMs: 0` in `.instar/config.json` (read at construction; restart sessions/server to apply) → the notice never fires; every other gate behaves identically.
- **Code back-out:** revert the three source edits — the notice is self-contained inside the `if (gate)` branch + one config field + one type field; nothing else depends on `pressureHeldNotified` or `pressureHeldNoticeMs`. No data migration, no state repair (the flag is in-memory).
- **Blast radius:** the change can only ADD a notice (the safe direction the operator demanded). There is no input it can reject and no path it can make quieter.

---

## Second-pass review (independent reviewer, Phase 5)

**Verdict: Concur with the review.** Verified against the code:

1. **Notice never affects the gate** — the `pressure-held` emit sits inside `if (gate)` after the gate decision; the function still returns `{ resumed: false, blocked: gate }` unchanged. Test asserts `blocked === 'calm-ticks'` directly.
2. **Per-episode dedupe is correct and re-arms in every sequence** — `pressureHeldNotified` set on emit, re-armed in the non-pressure `else` (pressure→quota→pressure) and on full clear (pressure→clear→pressure). No permanent-silence path; no double-fire (re-entrancy guard serializes ticks). Tests exercise all three.
3. **Deterministic delivery (G2 MAJOR 5) is true** — `raiseResumeAggregated` routes to `telegram.createAttentionItem` (the attention-queue path), NOT the tone-gated `/telegram/reply`. Same funnel as `ttl-expired`. The pressure it reports cannot stall its own delivery.
4. **Tests are non-tautological** — each asserts the real `aggregated` side-effect count plus message content; silence cases assert length 0 under genuinely-distinct gate conditions (dry-run, quota, sub-window).
5. **No race/shadow/TTL interaction missed** — flag is in-memory, single-threaded; `pressure-held` and `ttl-expired` share the aggregate item with distinct kinds. Wiring default `20*60_000` matches the type default.

**Minor non-blocking note (acknowledged):** the notice keys `heldMs` off the first READY candidate per `nextCandidates()` priority-then-queuedAt order, so an interactive entry in attempt-backoff could briefly mask an older `other`-class entry's true wait. This is inconsequential and CONSISTENT with the existing drain-candidate selection (the same ordering decides which entry actually revives next), so the measured wait is the wait of the entry that would be revived next — the correct thing to report. No change made.
