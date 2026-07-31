# Side-Effects Review — PromiseBeacon topic aggregation

**Tier:** 1
**Source of truth:** `docs/findings/2026-07-30-promise-beacon-notifies-per-element.md`
**ELI16:** `docs/eli16/promise-beacon-topic-aggregation.eli16.md`

## Change and causal fit

The defect is latent in the original per-commitment scheduler: every commitment independently reached the user-send chokepoint, so message cardinality scaled with backlog size. The fix sits at that chokepoint. Every user-facing PromiseBeacon kind (`heartbeat`, `closeOut`, `rung2`, `terminal`) now enters one durable per-topic aggregate before delivery. No topic, routing, commitment authority, or verification API changes.

## Mixed-news and cadence decision

The aggregate cadence is the **minimum effective cadence among visible open commitments and queued items**. This is one coherent topic rhythm, not an attempt to replay multiple per-promise clocks. It preserves the most urgent commitment’s timing and deadline-pressure opportunity while bounding output to one message. A quiet commitment is included in the `Open (N)` list but receives no update bullet. Only a qualifying commitment appears under `Updates (M)`. This prevents both false progress claims and silent omission.

## Over-block / under-block

Over-block risk is delayed information: a terminal or close-out notice arriving just after a summary waits until the next topic boundary. The commitment’s status transition happens immediately; only the user message is delayed, and the durable queue survives restart. The shortest-cadence rule bounds that delay by the most urgent participating commitment.

Under-block risk would be a side path calling the raw sender. All PromiseBeacon call sites now use `emitBeaconMessage`; `emitUserSend` is the private raw delivery implementation used only by the aggregate flush and by the explicit rollback / agent-owned authority branches. The burst test drives twelve commitments and asserts one message in-window. Independent topics remain independently bounded.

## Honest progress, deadlines, and escalation

Snapshot qualification, at-risk classification, unchanged suppression, sparse liveness, deadline-pressure wording, session-epoch authority, escalation rungs, auto-pause, and delivery outcomes remain upstream of aggregation. Aggregation changes composition and timing only. The mixed test proves quiet siblings never inherit the newcomer’s generated status. The terminal boundary test proves a session-loss violation is immediate in durable commitment state, queued behind the topic bound, and delivered at the next boundary.

## Durability and failure behavior

The pending batch is atomic tmp→rename state. Startup restores timers directly from aggregate files, including batches whose source commitment is already terminal or paused. A thrown/transient delivery keeps the attempted prefix and sets `nextAttemptAt` to one topic cadence later, preventing a tight retry loop. That prefix is frozen byte-for-byte under the same logical send identity; newer qualifications append behind it and wait for the following cadence. Delivered and delivered-equivalent outcomes retire only the attempted prefix. Permanent refusal, stand-down, agent-owned suppression, and terminal Attention rerouting are existing explicit alternate dispositions; they likewise retire only what they attempted, never a newer queued suffix.

Every new best-effort catch either reports through `DegradationReporter` or carries a specific `@silent-fallback-ok` explanation. Persistence failure throws after reporting, so the code never acknowledges an update that was not made durable. Post-delivery accounting drift is reported but never retries the already-delivered user message.

## Interactions and authority

The existing speaker election and ProxyCoordinator still run before heartbeat qualification. Agent-Owned Followthrough is evaluated both before enqueue and again before a fresh batch flush. If ownership changes while an item waits, the newly agent-owned item receives its existing suppression/terminal-reroute disposition before composition, and a currently user-visible sibling becomes the representative. This prevents either an agent-owned status leaking through a user-owned sibling or an agent-owned representative suppressing user-owned updates. An ambiguous retry is the deliberate exception: it was already authority-admitted and may already have reached the user, so its bytes and original logical send identity remain frozen until the typed delivery funnel resolves it. The aggregate never changes a commitment status and holds no new blocking authority. It is composition/scheduling, not a semantic verifier.

## Rollback and migration parity

`promiseBeacon.aggregateByTopic: false` restores direct per-promise sends. Pending aggregate files are additive hot state; rollback leaves them inert and does not alter commitment records. Config defaults and the existing idempotent PromiseBeacon config migrator backfill `true`. The generated agent-awareness text and its existing-agent migration both document the aggregate behavior and rollback lever.

## Class-Closure Declaration

**unbounded-self-action — closure: guard.** The change modifies a self-triggered notifier and adds a delayed retry timer, but it closes rather than expands the class: one timer per topic, one durable coalesced batch, a cadence floor, no retry faster than the topic cadence, and restart recovery over the same bounded files. `tests/unit/PromiseBeacon-aggregation.test.ts` is the ratchet: backlog burst cardinality stays topic/cadence bounded, exact-boundary behavior is pinned, topics do not cross-merge, restart retains queued work, and terminal lifecycle output cannot bypass the bound.

## Test tier

Tier 1 is sufficient: there is no route, schema, or production-only dependency injection seam. The unit harness uses real CommitmentTracker persistence plus the production PromiseBeacon class and delivery callback. Existing PromiseBeacon unit/integration suites remain the broader regression surface. No ratchet baseline is changed.
