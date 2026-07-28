# Side-Effects Review — Proactive Growth Digest Publisher (Slice 2)

**Version / slug:** `proactive-growth-digest-publisher-slice2`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 2 — converged + approved spec, 8-reviewer panel, 3 iterations)`

## Summary of the change

Adds `GrowthDigestPublisher` (`src/monitoring/GrowthDigestPublisher.ts`): an in-process
component that consumes the existing `monitoring.growthAnalyst.digestCron` and, on that
cadence, formats ONE consolidated "growth check-in" from the already-computed
`GrowthMilestoneAnalyst.buildDigest()` and routes it through the existing flood-guarded
post-update path. It is the cadence + delivery half (Slice 2) of the growth analyst;
Slice 1 (compute + read routes) already shipped. To give the publisher a delivery path
that provably cannot bypass the dedup/budget/tone guards, the change carves a pure,
`res`-free `evaluateOutbound` funnel out of `checkOutboundMessage` in
`src/server/routes.ts` and adds a `postToUpdatesTopic` helper both the route and the
publisher share. New config keys (`digestDelivery`, `digestTimezone`,
`digestSendOnCalmWeeks`) land in `ConfigDefaults.ts` + `types.ts`; wiring + teardown in
`AgentServer.ts`. Ships dark (`digestDelivery: 'off'` by default, even on a dev agent).

## Decision-point inventory

- `evaluateOutbound` (`src/server/routes.ts`) — **add** — pure res-free extraction of the
  localhost-link guard + tone-gate decision out of `checkOutboundMessage`. Both the route
  adapter and the publisher's `postToUpdatesTopic` call this single function.
- `checkOutboundMessage` (`src/server/routes.ts`) — **modify** — now a thin route adapter:
  fires the two observe-only observers (route-side) + delegates the decision to
  `evaluateOutbound` + maps the decision to res. Behavior byte-identical for callers.
- `postToUpdatesTopic` (`src/server/routes.ts`) — **add** — the publisher's guarded sender:
  resolve Updates topic → `evaluateOutbound` → `sendToTopic`. Returns a flat DeliveryResult.
- `GrowthDigestPublisher.publishOnce` — **add** — the lease-gate → mode → in-flight →
  calm → format → deliver decision chain. The publisher holds NO authority: it only sends
  a message or stays quiet; a guard block is a normal, non-error outcome it never re-acts on.
- `digestDelivery` / `digestSendOnCalmWeeks` / `digestTimezone` config — **add** — the
  rollout + cadence dials under `monitoring.growthAnalyst`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The `evaluateOutbound` extraction preserves the EXACT block/allow logic of the prior
`checkOutboundMessage` (localhost-link guard + tone gate). No new block surface is added;
the decision function returns the same 422 bodies for the same inputs (verified by the
existing `post-update-gate-budget-route`, `localhost-link-guard-route`, and
`outbound-content-dedup-route` suites — all 20 tests pass unchanged). The publisher itself
adds no block/allow surface — it is a sender, not a gate. Over-block: not applicable to the
new code; preserved for the refactored code.

---

## 2. Under-block

**What failure modes does this still miss?**

The publisher's bounded multi-machine handoff edge (§3.7): if a lease handoff falls between
a window's fire time and the newly-awake machine's `.start()`/catch-up, that one window can
be re-sent once (the per-machine audit log has no record of the old machine's send). This is
a deliberately-accepted under-guard in the SAFE direction — a single bounded re-send through
the same aggregating/budgeted/deduped funnel, biased toward "the check-in arrives" over
"silently dropped," which is the slice's entire reason to exist. The near-simultaneous case
is absorbed by the shared `evaluateOutbound` dedup. No new under-block in the message-gate
logic (the refactor is behavior-preserving).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Correct layers. The publisher is a thin cadence/delivery wrapper (low-level orchestration)
that DELEGATES the block/allow decision to the existing smart gate via the shared
`evaluateOutbound` — it does not re-implement guarding. The formatter is a pure render with
no decision authority (the analyst already decided what crosses a rule). The funnel
extraction is specifically a level-of-abstraction fix: it ensures the publisher FEEDS the
existing chokepoint rather than running a parallel un-guarded `sendToTopic`. The two
observe-only observers (`observeSelfViolation`, `observePrincipalCoherence`) deliberately
stay route-side, not in `evaluateOutbound` — they have nothing to catch on a proactive
digest (it credits no operator role and is authored by no principal), so keeping them out
of the shared funnel both preserves byte-identical caller behavior and avoids meaningless
telemetry.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface (the publisher is a sender; the
  refactored `evaluateOutbound` keeps the SAME smart gate — `messagingToneGate`, an
  LLM-backed authority with recent conversational context — as the sole decider).

The publisher produces a message or stays silent; it never blocks, delays, or rewrites
anything. The §3.5 superseded-job belt is a SIGNAL (an audit line), never a cross-component
mutation — the publisher never disables another component's job. The funnel extraction
keeps the single smart authority (`messagingToneGate`) and merely makes the publisher route
through it rather than around it. No brittle detector gains block authority.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `evaluateOutbound` runs the same localhost-guard-then-tone-gate order as
  before; `checkOutboundMessage` still fires the two observers FIRST (route-side), so no
  existing route caller's observation is shadowed. The publisher path intentionally does NOT
  fire those observers (nothing to catch) — confirmed not relied on for the digest path.
- **Double-fire:** the in-process cron runs on BOTH the awake and standby machine → the
  lease gate (`isAwake`) ensures only the awake machine sends (mirrors the
  scheduler/ActivitySentinel precedent the superseded `initiative-digest-review` relied on).
  The superseded job + the publisher both fire `0 11 * * 1` — handled by §3.5 (durable
  source-template disable at the live-flip, NOT at this dark merge; while `digestDelivery`
  is `off`/`dry-run` the publisher doesn't send, so the job stays the sole voice).
- **Races:** the in-flight guard + croner `protect:true` prevent overlapping `publishOnce`
  passes. The audit log is the single shared state; window-key idempotency is recorded only
  on a real post-lease decision.
- **Feedback loops:** none — the digest reads analyst state and emits one message; it feeds
  no system that feeds back into the analyst.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none — internal component, no shared external state.
- **Install base:** none at merge — ships `digestDelivery: 'off'`; existing agents get the
  three new config defaults via `applyDefaults` add-missing-only deep-merge (no migrateConfig
  needed, matching the rest of the `growthAnalyst` block). No CLAUDE.md template change at
  this dark merge (it rides the live-flip per the Agent Awareness Standard, parent §9).
- **External systems (Telegram):** only when an operator flips `digestDelivery` to
  `dry-run`/`live` — and then it sends ONE message into the EXISTING Agent Updates topic via
  the same guarded path as `/telegram/post-update`. Never a new topic, never per-finding.
- **Persistent state:** a new append-only audit log at `logs/growth-digest.jsonl`
  (best-effort, never throws). No DB, no schema change.
- **Timing:** the weekly cron + a 60s settle-delayed catch-up; the cadence sanity-floor
  refuses a sub-hourly `digestCron`.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change shipping dark — revert and ship a patch. No persistent state needs cleanup
(`logs/growth-digest.jsonl` is an inert append-only log; leaving it is harmless). No agent
state repair (the publisher is simply not constructed when `digestDelivery: 'off'`). No
user-visible regression during the rollback window, because at merge nothing is sent
(default off). The `evaluateOutbound` extraction is behavior-preserving and covered by the
pre-existing route suites, so reverting it carries no caller-facing risk either.

---

## Conclusion

This review found no new block/allow surface and no signal-vs-authority violation: the
publisher is a sender that delegates every guard decision to the existing smart gate via a
deliberately-extracted single funnel, closing off the "second un-guarded send path" the
review flagged in the draft. The multi-machine double-send (the one SERIOUS finding from
convergence) is fixed by the lease gate; the bounded handoff re-send is an accepted,
SAFE-direction tradeoff. The change ships dark with zero user-facing surface at merge, so
rollback is a plain revert. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required

The change carries a converged + approved Tier-2 spec
(`docs/specs/PROACTIVE-GROWTH-DIGEST-PUBLISHER-SLICE2-SPEC.md`) reviewed by an 8-reviewer
panel (security, scalability, adversarial, integration, lessons-aware + gemini) over 3
iterations; the convergence report is the independent-read record.

---

## Evidence pointers

- `src/monitoring/GrowthDigestPublisher.ts` — the publisher + pure `formatDigest` +
  `createGrowthDigestAuditSink`.
- `src/server/routes.ts` — `evaluateOutbound` (pure funnel), `checkOutboundMessage`
  (thin adapter), `postToUpdatesTopic` (publisher sender), `attachSender` hookup.
- `src/server/AgentServer.ts` — construction gate (`analyst && digestDelivery !== 'off'`),
  lease gate (`isAwake`), `.stop()` teardown.
- `tests/unit/GrowthDigestPublisher.test.ts` — 21 tests (publishOnce matrix, lease gate,
  in-flight guard, missed-run catch-up idempotency, sanity-floor, formatter guarantees).
- `tests/integration/growth-digest-publisher.test.ts` +
  `tests/integration/growth-digest-publisher-wiring.test.ts` — guarded delivery + single-
  funnel + sender-not-a-no-op + lease-gate wiring (10 tests).
- `tests/e2e/growth-digest-publisher-lifecycle.test.ts` — boots the real AgentServer:
  LIVE lands one check-in in the Updates topic; OFF / no-analyst → publisher null (3 tests).
- `tests/integration/notification-flood-burst-invariant.test.ts` — 500-finding burst → one
  bounded message, high-priority finding rendered in full.
- `npm run lint` clean (incl. dev-agent-dark-gate); analyst + ConfigDefaults regression
  suites green (80 tests).
