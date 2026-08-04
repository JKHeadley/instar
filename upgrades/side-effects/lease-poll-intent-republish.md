# Side-Effects Review — lease-derived poll intent is republished on every reconcile

**Version / slug:** `lease-poll-intent-republish`
**Date:** `2026-08-03`
**Author:** `echo`
**Second-pass reviewer:** `not required` (see §Second-pass — no block/allow surface added; the change is confined to a signal producer)

## Summary of the change

`MultiMachineCoordinator.reconcileRoleToLease()` published the lease-derived poll intent (`state/telegram-poll-intent.json`) only on a genuine role TRANSITION, because the `writeLeasePollIntent(holds, desired)` call sat below the `if (desired === this._role) return;` early-return. `_role` is restored from the machine registry at startup, so a machine that was already `awake` before a restart re-enters reconcile with `desired === this._role`, returns early, and never replaces `initializeLease()`'s safe boot default `{shouldPoll:false, role:'standby'}`. The published intent for a machine that genuinely holds the lease therefore stayed `standby / do-not-poll` permanently. A second failure mode rode along: because the record was written only on transitions, on a steady role its `ts` aged past the consumer's `maxStaleMs: 90_000` bound and `effectivePollIntent` degraded it to "no current opinion".

This change moves the publish ABOVE the early-return so it runs on every reconcile, and adds a throttling wrapper (`publishLeasePollIntent`) that writes when the intent changes (`shouldPoll | role | leaseEpoch`) or when the last SUCCESSFUL write is older than `POLL_INTENT_REFRESH_MS` (30s — a 3× margin inside the consumer's 90s bound). `writeLeasePollIntent` now returns whether a record actually landed, so a failed write never records a skip-window.

**A SECOND defect was found while building the real-boot-path test, and is fixed here too.** `initializeLease()` wrote its "safe boot default" (`writeLeasePollIntent(false, 'standby')`) at the very END of the method — but every branch above it already ends in `reconcileRoleToLease(...)`. The default therefore did not stand in for an unmade decision; it OVERWROTE the decision that had just been made three lines earlier. Its own comment ("at boot the role isn't yet reconciled … before the first reconcile decides the real role") describes the intended ordering, which the code did not have. On its own this defect is sufficient to leave a lease HOLDER published as `standby / do-not-poll` for the life of the process, so fixing only the early-return would have produced a change that passes a stubbed unit test and still fails in production. The default write is moved to before the branch.

Files touched: `src/core/MultiMachineCoordinator.ts`, `tests/unit/MultiMachineCoordinator-pollIntentRepublish.test.ts` (new).

## Decision-point inventory

- `MultiMachineCoordinator.reconcileRoleToLease` (poll-intent publish) — **modify** — publishes on every reconcile instead of transitions only; the transition-only side effects below the early-return are untouched.
- `MultiMachineCoordinator.initializeLease` (safe boot default) — **modify** — the default write moves from after the acquire/reconcile branch to before it. Same value written, same purpose; the ordering now matches the stated intent.
- `MultiMachineCoordinator.writeLeasePollIntent` — **modify** — now returns `boolean` (write landed) instead of `void`, and records the throttle state on every successful write. No behavioral change to what it writes.
- `MultiMachineCoordinator.publishLeasePollIntent` — **add** — throttling wrapper, no decision authority.
- `TelegramLifeline.reconcilePolling` (the CONSUMER, which owns the start/stop authority) — **pass-through** — unmodified. It keeps its own freshness gate, dead-writer gate, operator override, debounce, and the `pollFollowsLease.dryRun` gate.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** This change writes an advisory record. It has no reject path. The only actor that acts on the record is `TelegramLifeline.reconcilePolling`, which is unmodified.

The nearest analogue worth stating: the change can now cause the lifeline to STOP polling on a machine where, pre-change, it would have kept polling — but only when the machine genuinely does not hold the lease AND `pollFollowsLease.dryRun` is explicitly `false`. That is the intended contract, not an over-block: the record now reports the fenced lease truthfully instead of reporting a stale boot default.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.**

Failure modes this change does NOT address, stated explicitly so they are not assumed fixed:

- **A lifeline whose 409 counter never resets.** The production incident that surfaced this defect also showed `conflict409Stuck` firing after a single 409 in a fresh boot cycle, because the boot path starts polling (stale-connection flush → `Telegram polling active`) before the first `reconcilePolling` tick can mute it. Fixing the publisher removes the CAUSE of the dual-poll on a correctly-leased pair, but a lifeline that starts polling at boot and only reconciles 15s later still has a window. Not in scope here and not claimed fixed. <!-- tracked: ATT-poll-intent-standby-forever-20260803 -->
- **`nobodyPollingRecovery` shipping in dryRun.** If the lease is held by a machine that is down, nothing currently actuates a recovery. Unchanged by this. <!-- tracked: ATT-poll-intent-standby-forever-20260803 -->
- **A machine whose `_role` and the fenced lease disagree for a reason other than the missing republish.** This change makes the PUBLISHED record follow `holdsLease()` directly, so it is now independent of `_role` drift — but it does not repair `_role` itself.

---

## 3. Level-of-abstraction fit

Right layer. The coordinator is the only component that owns the fenced lease, so it is the only component that can answer "should this machine own the Telegram poll?". The record is the existing, purpose-built IPC surface between the server (which knows the lease) and the lifeline (which owns the socket), and it already carries the integrity fields (`serverPid`, `bootId`, `ts`) the consumer needs.

A lower layer (the lifeline asking Telegram, or reading the lease file itself) would duplicate lease parsing in a second process and reintroduce exactly the split-truth this record exists to prevent. A higher layer (a new arbiter service) is unwarranted for a one-boolean handoff.

No smarter gate exists that this should feed instead — the consumer IS the gate, and it already receives this signal.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces a signal consumed by an existing smart gate.**

The coordinator is a detector here: it reports a fact it alone holds (do I hold the fenced lease, at which epoch). It gains no blocking power from this change. The authority over polling remains `decidePollAction` inside `TelegramLifeline`, which combines this signal with the operator override (`pollOverride` / `telegramPolling:false`), the local 409 observation, the start debounce, and the `peerPresumedGone` conservatism — and is itself gated behind `pollFollowsLease.dryRun`.

The defect being fixed is, in signal-vs-authority terms, a detector reporting a value it never measured: the safe boot default is a placeholder standing in for an unmeasured role, and it was being consumed as though it were a measurement. Making the detector report the measured value is the compliant direction.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals decision point. The published value is a direct, deterministic read of a single authoritative signal — `leaseCoordinator.holdsLease()` — not a weighing of competing signals. The place where signals genuinely compete (lease intent vs local 409 vs operator override vs debounce) is `decidePollAction`, which is unchanged.

The only new constant, `POLL_INTENT_REFRESH_MS`, is a write-amplification throttle, not a decision threshold: it never changes WHAT is published, only how often an unchanged value is rewritten, and it is derived from the consumer's existing `maxStaleMs` bound (30s vs 90s) rather than tuned.

---

## 5. Interactions

- **Shadowing:** the publish now runs BEFORE the early-return, so it executes on strictly more paths than before. It cannot shadow anything — it writes a file and returns; no control flow depends on its result. Nothing that previously ran still fails to run. The reverse shadowing is what the second defect WAS: the boot default shadowed the reconcile's decision by writing after it. Moving it before the branch removes that, and the "does NOT acquire ⇒ left muted" test is the control proving the safe default still wins on the branch where no decision is made.
- **Throttle vs direct writers:** the throttle cache is now updated inside `writeLeasePollIntent` rather than in the wrapper, so a direct caller (the boot default) can never leave the cached key describing something other than what is on disk. Without this, the boot default would write `standby` while the cache still read `awake`, and the next reconcile would consider itself unchanged and skip the correcting write for up to 30s — the exact interaction that made the first draft of the real-boot-path test fail.
- **Double-fire:** on a genuine transition the publish runs once (from the new call above the early-return); the old call below the early-return was REMOVED, so there is no double write. Verified by the transition test asserting one write plus one `roleChange`/`promote` pair.
- **Races:** `writePollIntent` is atomic (tmp + rename), so the lifeline never reads a torn record — unchanged. The reconcile is single-threaded per process and already guarded by `leaseTicking`. The throttle fields are process-local and only mutated inside reconcile.
- **Feedback loops:** the record feeds the lifeline, which starts/stops polling, which changes the local 409 observation, which feeds `decidePollAction`. This change does not add a loop — it makes the existing one's input correct. The relevant risk (a machine flipping poll on/off repeatedly) is bounded by the existing start-debounce and by `POLL_INTENT_REFRESH_MS` throttling of unchanged values; a genuine flip publishes immediately, which is required for correctness (a lagging record is what caused the incident).
- **Churn breaker (B2):** deliberately left below the early-return so it still counts only true flips. Covered by the "does NOT re-fire transition-only side effects when the role is steady" test.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the record is per-agent under that agent's `stateDir`.
- **Other users of the install base:** the change is inert unless `pollFollowsLease` resolves on. It ships dev-gated; on the fleet the guard resolves off and `writeLeasePollIntent` returns early, writing nothing. No fleet-visible change on this commit.
- **External systems:** no direct calls. Indirectly, on an agent with `pollFollowsLease.dryRun:false`, Telegram sees one long-poll instead of two competing ones — which is the intended end state and strictly fewer 409s.
- **Persistent state:** `state/telegram-poll-intent.json` only. Same schema, same fields, same atomic write. Written more often (bounded to once per 30s per unchanged value). No migration: the record is regenerated at runtime and readers already tolerate a missing/stale/corrupt file by treating it as "no opinion".
- **Timing / runtime conditions:** the throttle uses wall-clock `Date.now()`. A backwards clock step could delay a refresh by up to the step size; the consumer's response to a too-old record is "no opinion → hold", the safe direction, so a clock anomaly degrades to today's behavior rather than to a wrong action.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or changed. The existing levers (`pollOverride`, `telegramPolling`) are untouched.

---

## 6b. Operator-surface quality

**Not applicable** — this change touches no dashboard renderer, approval surface, notification body, or operator-facing markup. No operator-facing text is added or modified.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The record answers a question that MUST differ per machine: "should THIS machine own the Telegram poll?" Exactly one machine may answer yes at a time, so replicating the record would be actively wrong — a replicated `shouldPoll:true` landing on a standby is precisely the dual-poll failure the fenced lease exists to prevent. The cross-machine coordination is carried by the fenced lease itself (already replicated via `LeaseCoordinator` / the mesh transports), and the record is the machine-local projection of that shared truth into a sibling process.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state on topic transfer:** the record is not topic-scoped and holds no per-topic state, so it cannot strand on a transfer. It is regenerated from the lease on the next reconcile on whichever machine holds it.
- **Generated URLs:** none.

Worth naming explicitly: this defect is itself a multi-machine defect that a single-machine install can never surface (a single machine short-circuits to `awake` and there is no second poller to conflict with). The evidence for this review came from a live two-machine pair, which is the graduation gate the parent spec names for B1/B5.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit and ship as the next patch. One function plus one constant plus two fields.
- **Data migration:** none. The record is advisory and regenerated at runtime; readers already treat missing/stale as "no opinion".
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility:** none during the rollback window on the fleet (the guard resolves off there). On a dev agent with the gate on, reverting restores the previous behavior exactly: the boot default stands and the lifeline holds or fights, as before.

---

## Conclusion

The review changed the design twice. First, `writeLeasePollIntent` was changed to return a success boolean so the throttle can never record a skip-window off a write that failed — without that, a transient write failure would have suppressed retries for 30s, and the consumer would have aged into "no opinion" for a reason the code believed it had handled.

Second and more importantly: writing a test that runs the REAL boot path, rather than only the stubbed reconcile, surfaced a second independent defect — the safe boot default being written after the reconcile it was meant to precede. Shipping the early-return fix alone would have produced a green unit suite and an unchanged production failure. That is worth recording as the reason the extra test existed: the stubbed tests could not have caught it, because they never ran `initializeLease()`. The throttle-cache ownership move (into `writeLeasePollIntent`) came out of the same test failing a second time for a different reason.

Third, §2 forced an explicit statement of what this does NOT fix: the lifeline's boot-time poll-before-first-reconcile window and the dry-run `nobodyPollingRecovery` are both still open, both tracked on the attention item, and neither is claimed closed by this commit.

The change complies with signal-vs-authority: it corrects a detector's output and adds no authority. It is inert on the fleet (dev-gated producer) and its whole risk surface is confined to agents that have explicitly enabled `pollFollowsLease`.

---

## Second-pass review

**Not required.** Phase 5 triggers on changes that touch block/allow decisions on messaging or dispatch, session lifecycle, or anything named sentinel/guard/gate/watchdog. This change adds no block/allow surface and modifies no gate: it is confined to the producer side of an advisory record, and the consuming gate (`decidePollAction`) is untouched. The one adjacent trigger word — the lifeline's poll authority — is explicitly out of the diff.

Recorded for the reviewer's benefit if this judgment is revisited: the argument rests on the diff containing no change to `TelegramLifeline`, which is verifiable from the commit's file list.

---

## Evidence pointers

- Live measurement (instar-codey, Mac Mini, 2026-08-03 17:34 PDT, v1.3.1122): `/health → multiMachine.syncStatus` reporting `role:awake, holdsLease:true, leaseEpoch:21302` in the same second that `state/telegram-poll-intent.json` reported `role:standby, shouldPoll:false, leaseEpoch:21302`.
- Staleness half: the same record's age sampled at 10s intervals climbed 84.5s → 155.0s across an 80s window with no rewrite, i.e. past the consumer's 90s bound.
- Downstream harm on that agent: 812 × `Telegram 409 Conflict — another bot instance is polling`, 260 × `TelegramLifeline.selfRestart: conflict409Stuck`, server restarting every ~10 min for ~8h.
- Pre-fix test control: with `src/core/MultiMachineCoordinator.ts` reverted to `origin/main`, the headline regression test fails with `expected null not to be null` (no record written at all) — the right reason, not a missing-symbol error. 7 of 10 tests in the new file fail pre-fix; the 3 that pass are the gate-off guard, the real-transition guard, and the observe-only "does NOT acquire ⇒ left muted" guard, all of which are expected to hold either way.
- Second defect, found by the real-boot-path test rather than by reading: with only the early-return fixed, that test failed with the record on disk reading `{shouldPoll:false, role:'standby'}` while the in-process throttle key read `true|awake|1` — i.e. the correct value had been written and then overwritten by the boot default at the tail of `initializeLease()`. That divergence between the cache and the file is what identified the clobber.
- Attention item carrying the fleet risk and the mitigation that must be removed after deploy: `ATT-poll-intent-standby-forever-20260803`.

---

## Class-Closure Declaration

**Not applicable on both triggers, stated explicitly rather than omitted.**

1. **Agent-authored-artifact defect?** No. The defect is in hand-written TypeScript (`MultiMachineCoordinator.ts`), not in an LLM prompt, hook, config, skill, or standards text.
2. **Self-triggered controller added or modified?** No. `reconcileRoleToLease` is an existing control loop driven by the existing lease tick; this change adds no new loop, monitor, sentinel, reaper, scheduler, or recovery path, and fires no restart / swap / respawn / spawn / notify / retry / re-drive / kill. The throttle strictly REDUCES the action rate of an existing loop (a file write) and cannot increase it: an unchanged value is written at most once per `POLL_INTENT_REFRESH_MS`, and a changed value at most once per reconcile tick, which is the loop's own bound.
