# Side-Effects Review — announce a paused feedback readiness authority

**Version / slug:** `feedback-readiness-pause-alarm`
**Date:** `2026-10-18`
**Author:** `Echo`
**Second-pass reviewer:** `not required (signal-only notice; no gate, session lifecycle or authority change)`

## Summary of the change

The feedback drain's readiness authority pauses itself (`proposal-only`) on three deliberate brakes, and only the operator's dashboard PIN restores it. The pause was silent; on 2026-10-14 it froze the drain for four days with nobody told. This change adds one attention item per paused (authority, generation): raised right after each `demoteAuthority` call in `FeedbackDrainService`, from the tick's authority-unavailable branch, and from `FeedbackDrainTickProxy.acceptOwned`'s 403 refusal (the only code that still runs while paused). Files: `src/feedback-factory/drain/FeedbackDrainService.ts`, `src/feedback-factory/drain/FeedbackDrainTickProxy.ts`, `src/server/AgentServer.ts` (wires `raiseAttention` to the same `telegramAdapter.createAttentionItem` funnel triage uses), `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, tests.

## Decision-point inventory

- Readiness brakes (`demoteAuthority` ×3) — **pass-through** — unchanged; a notice is raised after them.
- Drain tick gateway 403 (`canAgentMutateReadiness`) — **pass-through** — unchanged refusal; a fire-and-forget notice call is added before returning.
- No new decision point.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The 403 response is byte-identical.

## 2. Under-block

No block/allow surface. Notice gaps: a non-canonical machine never raises it (by design, the owner does); if the attention funnel is unavailable (no Telegram adapter) the notice cannot be delivered and is retried on every refused tick, silently, until it can. A pause caused by revocation (`revoked: true`) is an operator action and is not announced.

## 3. Level-of-abstraction fit

Right layer. The drain service owns the brakes, so it raises the notice where it demotes. The gateway refusal is the one place code still runs while paused, so the late-notice hook lives there, delegating back to the service. It reuses the existing durable attention funnel and the existing `brakePlainWords` text instead of a new notifier or new wording table, mirroring how `FeedbackTriageService` already announces its own authority problems.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It produces a notice only. It never restores, retries, re-grants or changes the authority; the PIN gate is untouched (the tests assert the posture stays `proposal-only`).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The trigger is the recorded posture `proposal-only`, an enumerable state.

## 5. Interactions

- **Shadowing:** none; the notice runs after the existing demotion and before the existing 403 return.
- **Double-fire:** the three demotion sites and the refusal path all use one id per (authority, generation); an in-process set plus the attention store's own id idempotency (`createAttentionItem` returns the existing item for a known id) keep it to one item. The triage service's own items use different ids and sources.
- **Races:** `notifyIfReadinessPaused` is fire-and-forget; two concurrent refusals could both call the enqueue before the set is updated; the store's id idempotency collapses them.
- **Feedback loops:** none; the notice does not feed the drain.

## 6. External surfaces

- Operator: one new attention item per pause, posted through the existing Attention routing (single hub topic by default). Priority HIGH only for the wrong-model/prompt brake.
- Operator surface (Mobile-Complete): the restore action is the existing dashboard Feedback Drain card (PIN, phone-usable); the item points there. No new operator action.
- Other agents/install base: only operated feedback-factory hosts run the drain; elsewhere this is inert.
- Persistent state: the attention store gains the item; nothing else.

## 6b. Operator-surface quality

No operator surface file changed — not applicable. (The attention text leads with what stopped and the one restore step, in plain words, no ids in the summary.)

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the drain runs on its canonical owner only, the brakes fire there, and `notifyIfReadinessPaused` returns unless this machine is the canonical owner. One voice: exactly one machine can raise it. The attention item is visible pool-wide through the existing `GET /attention?scope=pool` merged read.

## 8. Rollback cost

Pure code change; revert and ship a patch. A raised item stays in the attention store until resolved (harmless). The CLAUDE.md bullet would remain on migrated agents; the marker sniff keeps any later re-add idempotent.

---

## Conclusion

Closes the silence half of the 2026-10-14 freeze without touching the deliberate PIN boundary. The e2e test on the production wiring caught a real design gap during the build (a paused authority refuses every tick, so an in-tick check alone would never fire); the refusal-path hook was added because of it. Clear to ship.

---

## Second-pass review (if required)

Not required: no gate, no session lifecycle, no authority change; the change only adds a deduped notice.

---

## Evidence pointers

Drain store `drain_audit` rows 2042–2052 on the Mac Studio (2026-10-14); tests listed in `upgrades/next/feedback-readiness-pause-alarm.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered restart/swap/respawn/kill controller added; the notify is a once-per-id enqueue bounded by authority generations (each requires an operator PIN approval to create) — not applicable beyond that bound.
