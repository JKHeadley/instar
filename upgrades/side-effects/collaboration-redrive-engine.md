# Side-Effects Review — CollaborationRedriveEngine

**Spec:** `docs/specs/collaboration-redrive-on-counterpart-silence.md` (approved 2026-05-28)
**Change:** add `src/monitoring/CollaborationRedriveEngine.ts`; add `redriveCount`/`lastRedriveAt`/`lastRedriveText` optional fields to `Commitment`; backfill in `loadStore()`; default new threadline-reply commitments with `redriveCount: 0`; wire construction into `src/commands/server.ts` after `completionEvaluator` (ships OFF).

## 1. Over-block / under-block
**Over-drive:** nudging a counterpart who is legitimately working. Mitigated by the `CompletionEvaluator` "objective-met" gate (auto-closes the commitment instead of nudging), the silence threshold, the per-commitment cap, the per-peer/daily/per-tick fuses, and (decoratively) the novelty tiebreaker. The cap biases toward UNDER-drive (stop + escalate), which is the safe direction.
**Under-drive:** never nudging → that is today's gap and the thing this fixes. The ship-OFF default is the strongest under-drive bias; we dogfood-on-Echo before any rollout.

## 2. Level-of-abstraction fit
Composes existing primitives — no new transport, no new persistence store. Reads/writes existing `Commitment` records via `mutate()`; sends via the same `threadlineRelayClient.sendPlaintext` the inbound auto-ack path uses; surfaces via the existing `CollaborationSurfacer.notify`; escalates via `telegram.createAttentionItem` (injected `raiseAttention`). The engine is a small monitor sibling to `PromiseBeacon` / `CommitmentTracker`.

## 3. Signal vs Authority
Stall + not-met are SIGNALS. The bounded nudge is a limited action with a hard cap. The OPERATOR holds terminal authority — when the cap is hit, the engine raises an Attention-queue item ("collaboration with <peer> stalled — your call") and goes silent. The engine cannot decide to keep going past the cap.

## 4. Interactions
- `CommitmentTracker`: adds optional fields; uses `getActive()` + `mutate()` + `markReplyArrived()` (already only-touches-`lastReplyAt`).
- `PromiseBeacon`: independent. The engine runs its OWN sweep so most threadline-reply commitments (which are NOT beacon-enabled) are still covered.
- `WarrantsReplyGate`: the peer's gate suppresses our nudge if it's pure-ack; the engine sends concrete questions/next-steps so it warrants reply (convergence-driving by construction).
- `CollaborationSurfacer`: visibility-only — silent hub posts; does not buzz the operator.
- Attention queue (`telegram.createAttentionItem`): used only at cap-hit + after N consecutive name-resolution misses.

## 5. Rollback
Ships OFF (`monitoring.collaborationRedrive.enabled: false`); flipping back to false fully disables. The new fields are additive/optional — no destructive data transform; the only "migration" is an idempotent backfill defaulting `redriveCount: 0` on existing rows (safe to remove — would just read back as `undefined`, which the engine treats as 0).

## 6. Data integrity
The only mutation to existing Commitment lifecycle semantics is the auto-close on objective-met (transitions `pending → delivered`), which is a documented terminal transition this engine is now authorised to make. All other writes are to the new additive fields. The cap and spacing live durably on the commitment record (via `mutate()`), not in PromiseBeacon hot-state, so they survive restart.

## 7. Failure modes
- **Runaway nudges (incl. mutual re-drive):** bounded by the durable reply-independent cap + per-peer 24h cap + engine-wide daily fuse + per-tick fuse. The cap is the ONLY termination guarantee; novelty is decorative. Tested.
- **Restart amnesia:** cap/spacing persisted to `commitments.json` via `mutate()`. Restart-survival test required and present.
- **Clock jump / sleep-wake burst:** per-tick fuse + `Number.isFinite` validation + injectable `now()`. NaN/future timestamps disqualify, fail-safe.
- **Peer ack-storm in response:** the peer's own `WarrantsReplyGate` suppresses inbound; our durable cap stops our side regardless of replies.
- **Wrong-peer send:** name→fingerprint resolved via `known-agents.json`; unresolved or ambiguous names skip + don't increment + escalate after N strikes. A send is never attempted against a guessed address.
- **Re-drive while operator is mid-conversation:** visibility surfaces silently to the Threadline hub; never the active parent topic. Cap-hit escalates to the Attention queue, which the operator opens on their own schedule.
- **Evaluator unreachable:** errs to "not met" (keep waiting); an evaluator exception never produces an uncounted nudge — but the engine does NOT nudge on evaluator-throw this tick (the evaluator failure short-circuits the eligible path).
