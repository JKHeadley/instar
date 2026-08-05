# Side-Effects Review — Bounded Attention-Notification Surface

**Version / slug:** `bounded-attention-notification-surface`
**Date:** `2026-08-04`
**Author:** `echo`
**Second-pass reviewer:** `required — see below (Phase 5 trigger: outbound-messaging block/allow surface)`

## Summary of the change

Bounds the volume of agent-initiated messages into an existing conversation, and stops routine degradation reports reaching the operator by default. Four changes, spec at `docs/specs/bounded-attention-notification-surface.md`: **C1** gates `DegradationReporter`'s Telegram alert behind `monitoring.degradationReporter.notifyUser` (default `false`; console, disk, and feedback records unchanged). **C2** makes `NotificationBatcher.enqueue()` honour `config.enabled` for `SUMMARY`/`DIGEST` and builds the batcher from config instead of hardcoded literals. **C3** persists the cross-batch suppression map to `<stateDir>/notification-suppression.json` with a 24h TTL. **C4** adds a rolling-window rate limit (default 4/topic/hour) enforced **only by the machine that owns the topic**, with held items self-releasing, bounded at 200 per topic, and a `maxHoldHours` terminal EXPIRY for persistently-blocked topics.

Files actually changed: `src/messaging/NotificationBatcher.ts`, `src/monitoring/DegradationReporter.ts`, `src/commands/server.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`, and two new unit-test files plus edits to two existing ones.

**Two honest corrections to an earlier draft of this line.** It listed `src/core/ConfigDefaults.ts`, which was **not** touched: the runtime defaults inline at the construction site and `migrateConfigBoundedNotificationSurface` surfaces the keys into existing configs, so a ConfigDefaults entry would be a third place for the same numbers to drift out of sync. It also claimed "unit/integration/e2e tests" — only **unit** tests were written. The Testing Integrity Standard's Tier 2/3 exist for features with API routes; this change adds none, and its production-wiring path is covered by the config→batcher tests in `bounded-notification-surface-migration.test.ts`. Claiming three tiers where one was written is exactly the description-not-the-thing failure this project keeps re-learning, so it is stated rather than left standing.

Motivating measurement: 64 attention messages/24h on this agent (25 pure housekeeping), 65/33 on a second agent, against 781 recorded `[DEGRADATION]` events in the same period.

## Decision-point inventory

- `DegradationReporter.reportEvent()` → telegram branch — **modify** — adds a config gate; the event's own classification is untouched.
- `NotificationBatcher.enqueue()` — **modify** — honours the existing (previously dead) `enabled` flag for batched tiers only.
- `NotificationBatcher.flush()` → send decision — **add** — rolling-window count and topic-ownership check.
- `notify()` in `server.ts` — **pass-through** — call sites and tiers unchanged.
- Topic ownership (pool placement) — **pass-through** — this change *consumes* an existing ownership decision; it does not make or modify one.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **A genuinely important degradation is silenced by C1's default.** A `DegradationReporter` event that a user *would* have acted on no longer reaches them. Concrete shape: a fallback that silently changes behaviour the operator depends on — e.g. "quota readings now estimated rather than authoritative" — is now log-only. Mitigation is a routing argument, not a denial: paths that carry action-required content (attention queue, health-alert path, `IMMEDIATE`) are untouched. The residual risk is a producer that *should* be using those paths and instead emits a degradation event. That is a producer defect this change makes visible rather than creates, but it is a real over-block and is named as such.
- **A non-owning machine's batched digest never reaches the operator.** With C4, items enqueued on a machine that does not own the topic are queued locally and expire on `maxHoldHours` if ownership never arrives. If a machine-local condition matters and is only reported via a batched digest on that machine, the operator does not see it. Content stays readable in that machine's logs.
- **A burst of 5+ genuinely distinct, genuinely useful notices in one hour** is trimmed to 4 with the rest delayed. Delay, not loss.

Not over-blocked: `IMMEDIATE`, attention-queue items, and ordinary conversational replies — none traverse this path.

**On enforcing correct routing at the producer (re-review finding 5).** The re-review asked for a guard stopping a producer from emitting genuinely action-required content as a degradation event, where C1 now mutes it. Real risk, deliberately not solved here: distinguishing "actionable" from "routine" inside a degradation event means judging its content — precisely the brittle-authority shape §4 rejects, and this change's whole value is that it never reads a message. The correct home is the producer's own choice of surface. What this change does contribute is making misrouting *discoverable*: a muted event still lands in the log, on disk, and in the feedback system, so it is findable rather than lost. Producer-side guidance registered as follow-up. <!-- tracked: CMT-1184 -->

---

## 2. Under-block

**What failure modes does this still miss?**

- **A chatty producer using `IMMEDIATE`.** `IMMEDIATE` is exempt by design, so a component mis-tiering routine output as urgent floods exactly as today. This change does not audit tier assignment.
- **Volume across *different* topics — with the measured worst case, not a shrug.** The limit is per-topic. The re-review asked for a number rather than an acknowledgement: this agent has roughly 40 topics with any recent traffic, so the theoretical ceiling is 40 × 4 = **160 batched messages/hour**. The measured actual is 2.7/hour, because the binding constraint in practice is that housekeeping now stops at the source (C1) and only a handful of topics produce batched traffic at all. `topicCreationBudget` bounds *new* topic creation, so the surface cannot grow unboundedly. A global per-agent cap was considered and deliberately NOT added in this increment: it needs a second, coarser authority above the per-topic one, and the measured data does not yet show a value that would bind without suppressing legitimate multi-conversation activity. Registered rather than silently dropped. <!-- tracked: CMT-1184 -->
- **Non-batcher senders.** Anything calling `telegram.sendToTopic` directly, or the attention-queue path, is unaffected. This bounds one lane, not every lane.
- **The generator itself.** 781 degradation events/day continue to be produced; this change stops them being *messaged*, not *generated*. The memory pressure behind them is explicitly out of scope. <!-- tracked: CMT-1184 -->

---

## 3. Level-of-abstraction fit

C4 is a **low-level primitive** and belongs there: it is a count at the single `sendDirect` chokepoint every batched message already passes through. Putting it higher (a reasoning layer deciding "is this message worth sending?") would add a failure mode — mis-classification — for a decision that needs none.

It **uses** rather than re-implements two existing primitives: topic ownership comes from the pool's placement record (the same record the transfer protocol and duplicate reconciler act on), and the hold/coalesce machinery is the batcher's existing queue. No new component.

It is deliberately **parallel to, not feeding**, the tone gate and response-review pipeline: those judge *content* of conversational replies; this counts *volume* of batched housekeeping. They share no decision and cannot shadow each other.

C1 is a config gate at the emit site — the correct layer, since the alternative (filtering degradation text downstream) would mean pattern-matching message bodies, which is exactly the brittle-authority shape to avoid.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] **Yes — but the decision space is trivially small and content-blind.**
- [ ] ⚠️ Yes, with brittle logic — STOP.

C4 holds delivery authority. It qualifies because it is the *least* brittle authority available: it never reads a message. Its inputs are an integer count, a timestamp list, and a lookup in an existing authoritative record. There is no parsing, no classification, no model call, and therefore no way for it to mis-judge a message's content — the failure class the standard exists to prevent.

Its failure direction is bounded and safe: delay for housekeeping, and `IMMEDIATE` never enters the path at all. C1/C2/C3 are pure signal-suppression — they change what is delivered, never what is decided; no detector's verdict changes.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.**

Each decision here is an invariant with an enumerable domain, and the spec's `## Decision points touched` classifies all five as `invariant` with reasoning:

- C1/C2 read a config boolean — one input, no competition.
- C3 is an exact-match key lookup.
- C4.1 *consumes* an ownership verdict made elsewhere; it does not weigh competing ownership signals.
- C4.2 compares an integer to a fixed bound.

The one place competing signals genuinely exist — "is the owner unreachable enough to justify claiming or bypassing?" — is **delegated to the existing stale-owner-release path**, which already carries its own evidence bar, quorum, and audit. This change deliberately does not add a second, weaker judgment at that point.

---

## 5. Interactions

- **Shadowing.** C4 runs at `sendDirect`, *after* the tone gate and outbound advisory have already passed a message. It cannot shadow either: they judge content of conversational replies, and batched housekeeping does not traverse them. Conversely neither can shadow C4. C1 runs *before* `notify()` is called at all, so a suppressed degradation never reaches the batcher — the two compose as a filter then a limiter, not as competing gates.
- **Double-fire.** The pre-existing `ALERT_COOLDOWN_MS` (1h per feature) in `DegradationReporter` and C4's per-topic limit both act on the same event stream. They do not conflict — the cooldown thins per-feature, the limit bounds per-topic total — but they *stack*, so effective volume is lower than either alone. Stated so nobody later "fixes" an apparent under-delivery by removing one.
- **Races.** `sendTimes` and the suppression map are written from the flush path and read from the enqueue path within one process; both are single-threaded on the event loop. Cross-process is not a concern because C4.1 guarantees exactly one machine enforces per topic. The known race is a *transfer*: a topic moving machines mid-window means the new owner starts with its own `sendTimes`, permitting up to `limit` extra sends in the transfer hour. Bounded, one-off, and preferable to blocking a transfer on notification state.
- **Feedback loops.** C3's failure path reports a degradation event, which is itself a candidate notification. Loop is broken by C1 (degradation alerts default off) and bounded by C4 even if enabled. Explicitly checked, because a suppression-layer failure that floods via the suppression layer would be the worst possible bug here.

---

## 6. External surfaces

- **Other agents on the same machine:** none — all state is per-agent `stateDir`.
- **Install base:** yes, and this is the significant one. Every agent's operator receives **less**. That is the intent, and it is the reason the change was routed through operator approval rather than shipped as a default tweak. Operator confirmed (Justin, topic 7848, 2026-08-04, `"Silent"`).
- **External systems:** Telegram/Slack send volume drops. No API contract change.
- **Persistent state:** one new file, `<stateDir>/notification-suppression.json`. Self-creating, self-expiring, safe to delete.
- **Timing:** C4 depends on wall-clock for the rolling window. Clock skew on one machine affects only that machine's topics, since it is the sole enforcer.
- **Operator surface (Mobile-Complete):** **no new operator-facing actions.** Every lever is a config key the agent sets conversationally on request ("turn the housekeeping back on"), which is already phone-complete. No PIN-gated route, no form, no approval flow is added.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** This change stages no `dashboard/*` file, no approval page, and no grant/revoke/secret-drop form. The `getStats()` additions (`heldCount`, `heldSince`, `notOwnerSkipped`, `notOwnerExpired`, `ownershipBypasses`) feed the existing telemetry collector; no renderer is added or modified.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Declared per surface — this was the most-revised part of the design, redesigned three times under review.

- **C4 rate limit — `unified`, via single-enforcer ownership.** Only the machine owning a topic sends batched notifications into it, so the bound is exact rather than approximated. Ownership is a local read of the replicated placement record, not a call on the send path. Three earlier drafts divided a budget by machine count and were rejected: approximating a shared quantity from N independent local views cannot produce an exact shared bound.
- **C3 suppression state — `machine-local BY DESIGN`.** `machine-local-justification: physical-credential-locality` — the key embeds a Telegram forum topic id namespaced by the bot token that machine holds, so the key is meaningless elsewhere. Consequence: a repeat notice can cross machines once; C4's single enforcer bounds the total regardless.
- **C1 / C2 — `unified` by configuration.** Config booleans read identically on every machine of the agent. No new replication path.

**User-facing notices — one-voice gating:** yes, and it is the core mechanism, not an add-on. Batched notices are gated on ownership so two machines cannot both emit into one topic. `IMMEDIATE` *consults* ownership (claim-first when the owner is unreachable) but is never blocked by it.

**Durable state on topic transfer:** `sendTimes` does not follow a transfer; the new owner starts fresh, permitting up to `limit` extra sends in that hour. Named in §5 as an accepted bounded race. Held items on the old machine expire via `maxHoldHours` rather than stranding indefinitely.

**Generated URLs:** none.

**Known deviation, escalated rather than resolved here:** for an `IMMEDIATE` notice where the owner is both unreachable and unclaimable, **Ownership-Gated Side Effects** and **The Agent Is Always Reachable** genuinely conflict. Resolved toward reachability (an unproved-ownership send costs at most a visibly-stamped duplicate; the alternative costs an operator not learning of an urgent condition). The deviation is narrow, attributed, and audited via `ownershipBypasses`. Which standard should win is registered as a constitution-level question. <!-- tracked: CMT-1184 -->

---

## 8. Rollback cost

- **Hot-fix release:** revert the squash commit, ship as a patch. No code coupling outside the listed files.
- **Data migration:** none. `notification-suppression.json` is self-creating and safe to delete; nothing reads it after revert.
- **Agent state repair:** none. Config keys added by `migrateConfig()` become inert on revert; they are additive and do not overwrite operator values.
- **User visibility during rollback:** operators would resume receiving housekeeping — a return to today's behaviour, not a new regression.
- **Config-only partial rollback, no release needed:** `notifyUser: true` restores degradation alerts; `maxMessagesPerTopicPerHour: 0` disables the limiter (explicit guard, verified — without it `0` would hold everything, which an earlier draft got wrong).

---

## Conclusion

The review changed the design substantially rather than merely documenting it. The multi-machine approach was rewritten three times and ultimately replaced: single-enforcer ownership makes the distributed problem *not arise* instead of bounding it approximately. The failure direction was inverted for the batched lane — an earlier draft's "when in doubt, deliver" was correct for urgent messages and exactly backwards for housekeeping, where an extra message is the harm being removed. Two proposed operator-facing "N notices held" lines were removed, the second because it was itself unactionable housekeeping inside a change built to eliminate unactionable housekeeping.

The most significant process finding is not about this change: after ten rounds of section-by-section patching, the spec described two mutually exclusive architectures while the per-standard conformance gate returned **clean**. Only the whole-document cross-model reviewer caught it. The spec was rewritten from scratch and the tooling limitation recorded in its Review history.

Flagged for follow-up, not resolved here: the `IMMEDIATE` ownership deviation (constitution-level), the cross-topic volume gap in §2, and the memory pressure generating the events. All tracked. <!-- tracked: CMT-1184 -->

**Status: clear to build once the spec carries `approved: true`.** Not clear to commit before then — the pre-commit gate refuses, correctly, since this changes what every operator receives.

---

## Second-pass review (if required)

**Reviewer:** cross-model independent read (`codex-cli:gpt-5.5`) over this artifact plus the implementation.
**Independent read of the artifact: CONCERN raised — three real defects, all fixed.**

Note on the reviewer: the six internal Claude reviewers were not spawned as subagents (this session operates under a standing instruction not to spawn agents unless the operator requests it, and the operator did not). The second pass was performed by an independent non-Claude model reading the artifact and the code together. That is a genuine independent read, and it is disclosed rather than described as the full panel.

It found three defects that every prior review — and my own tests — had missed:

- **A failed send counted as a delivery.** `sendDirect()` swallowed sink failures while `flush()` still dequeued the item, wrote suppression, and charged a rate-limit slot. A failed Telegram send therefore dropped the notice *and* suppressed it for 24h: silent loss, and a direct contradiction of the spec's own "presence follows delivery" invariant. **Fixed** — the sink now reports success, and state changes only on a confirmed send.
- **Corrupt rate state eventually minted capacity.** `rate-state-unreadable` held correctly, but the aged-hold path collapsed it into a send, and a successful write cleared the unreadable flag while the map being written was the empty one that had failed to load. Two separate routes around the fail-closed rule. **Fixed** — such holds expire without sending, and the flag latches for the process lifetime.
- **The breaker was counted but never consulted.** The spec claimed three collapses drop a topic to DIGEST cadence for 24h; nothing read that state. Investigating produced a sharper finding: the collapse itself was **unreachable**, because the 1h window always clears before the 6h hold matures. **Both were removed rather than repaired** — a documented brake that cannot fire is worse than none, since a reader records it as protection that exists.

It also asked for the "exact" multi-machine guarantee to be qualified by placement consistency (**done** — it is now stated as inherited from the placement record, with the 2× split-brain case named), and noted the cross-topic volume gap, which was already disclosed in §2 and to the operator before approval.

Every fix carries a regression test with a control that fails when the guard is removed.

---

## Evidence pointers

- Spec: `docs/specs/bounded-attention-notification-surface.md` (Review history table: 13 conformance rounds, 3 cross-model passes).
- Plain-English overview: `docs/specs/bounded-attention-notification-surface.eli16.md`.
- Baseline measurement method: `.instar/telegram-messages.jsonl` filtered to the attention topic over 24h, classified by message shape; `logs/server.log` grepped for `[DEGRADATION]`.
- Control for the "no existing limit" negative: `topicCreationBudget`, `maxTopicsPerSource`, `attentionTopicGuard` all return non-zero from the same grep over the running dist, proving the search read the right tree.

---

## Class-Closure Declaration (display-only mirror)

**No agent-authored-artifact defect — not applicable** to the defect-fix arm.

**The self-action arm DOES apply**: C4 adds a self-triggered controller (a hold-and-retry loop that re-attempts held flushes without operator involvement).

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence`** — enforcement type `ratchet`; citation `tests/unit/self-action-convergence.test.ts` plus the burst-invariant test asserting the limit holds under a 100-event burst.

**Convergence argument.** *Control-loop edge:* held items → retry on window open → send → consume a window slot. *Steady-state bound:* the loop's output is capped at `maxMessagesPerTopicPerHour` per topic by construction; the input (queued items) is capped at `maxHeldItemsPerTopic`, so both sides of the loop are bounded and the queue cannot grow without bound. *Settling brakes:* retries are scheduled for the computed next-slot instant rather than polled, so attempts are O(1) per released slot rather than O(1) per minute; and `maxHoldHours` gives the hold a terminal state — a topic blocked for a persistent reason drops its backlog with an audit row and a per-reason counter, sending nothing.

*Two brakes claimed in an earlier draft were REMOVED, not repaired.* That draft cited a `maxHoldHours` collapse-to-send plus a breaker counting three collapses. Writing their tests proved both unreachable: the rolling window (1h) is far shorter than `maxHoldHours` (6h), so a rate-limit hold always drains before it can mature, and the only holds that persist that long are ones that must never age into a send. The collapse could only have fired where it was forbidden, and the breaker downstream of it could never trip. Citing them as convergence evidence would have been citing protection that does not exist — the precise defect class this project has been burned by. The convergence argument above rests only on brakes that are reachable and tested.
