# Side-Effects Review — Usher precision numerator wiring (rung 4)

**Version / slug:** `usher-precision-loop`
**Date:** `2026-05-28`
**Author:** `echo`
**Second-pass reviewer:** `not required` (signal-only observability change, no blocking surface)
**Spec:** `docs/specs/cwa-usher.md` (approved:true by justin; review-note explicitly names "the usher_acted precision definition that gates rung 5" as the in-scope follow-up this change implements)

## Summary of the change

The Usher fires re-surface signals (`UsherSignalStore.recordSignal`) and exposes a
precision read (`acted / fired`) that the spec designates as the hard precondition
for rung 5 (mid-task injection). But `UsherSignalStore.markActed` — the precision
*numerator* — had no caller anywhere, so `acted` was pinned at 0 on every topic
and precision could never move. This wires the numerator via two correlation paths
in a new pure helper `src/core/UsherActedCorrelator.ts`: (a) **auto-use** — when the
agent's outbound reply on a topic uses a re-surfaced context, mark that signal
`acted(via:'use')`, called from the `POST /telegram/reply` handler in
`src/server/routes.ts` after a genuine (non-proxy, non-system) reply sends; (b)
**miss-map** — when the user has to correct the agent (a `HumanAsDetector` signal)
on a context a recent nudge flagged, mark it `acted(via:'miss')`, called right after
the inbound `observeInboundMessage` seam in `src/commands/server.ts`. `markActed` now
also stamps `actedVia`/`actedAt`, and `GET /usher/metrics` reports
`acted_by_use`/`acted_by_miss`. Files: `UsherSignalStore.ts`, `UsherActedCorrelator.ts`
(new), `usherRoutes.ts`, `routes.ts` (+`RouteContext.usherSignalStore`),
`AgentServer.ts` (route ctx wiring), `server.ts` (path-b seam).

## Decision-point inventory

The only "decision" this change makes is whether to increment an observability
counter (`acted`). It gates nothing — no message is blocked, delayed, or altered.

- `UsherActedCorrelator.contextCoveredBy` — **add** — pure text-coverage match deciding whether a probe references a fired signal's proposition. Output feeds `markActed` only; no authority over delivery.
- `routes.ts POST /telegram/reply` (path a) — **pass-through** — the existing send decision is untouched; crediting runs *after* the reply has already gone out.
- `server.ts` inbound human-detector seam (path b) — **pass-through** — crediting runs after `observeInboundMessage`, which itself is signal-only.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. `markActed` only increments a
metric; it cannot reject, delay, or modify any inbound or outbound message. Both
call sites run strictly *after* the message has been processed/sent, and both are
wrapped best-effort (never throw into the message path).

## 2. Under-block

**What failure modes does this still miss?**

By design (precision-over-recall — a falsely-HIGH precision is the dangerous
direction since precision gates rung 5), the correlator deliberately UNDER-credits:

- **Path (a) timing race:** the Usher's signal is recorded by an async, LLM-backed
  fire-and-forget loop (~8–10s). A very fast agent reply can land before the signal
  is persisted, so that use goes uncredited. Acceptable: the full reply (after the
  agent's work) usually lands well after the signal persists, and under-crediting
  never inflates the gate.
- **Short contexts:** a context with fewer than 2 salient terms can never reach the
  `MIN_SHARED=2` threshold, so single-word propositions are never auto-credited.
- **Recency window:** uses/corrections outside `USE_WINDOW_MS` (6h) / `MISS_WINDOW_MS`
  (24h) are not credited.

These are recall gaps, not correctness bugs — the precision number will be a *floor*
on true usefulness, which is the conservative posture the rung-5 gate wants.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `markActed` already existed on `UsherSignalStore` (the spec's numerator); this
change only supplies its missing callers. The matching logic lives in a pure,
unit-tested helper (`UsherActedCorrelator`) rather than inline at the call sites,
and the two call sites are the two existing seams where the relevant text is already
in hand (outbound reply text; inbound correction text + its `HumanAsDetector`
verdict). No higher layer owns "was this nudge used" — this is the layer that has
both the fired signals and the probe text. No smarter gate exists that should own
it instead.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal?**

Compliant (`docs/signal-vs-authority.md`). The coverage matcher is intentionally
brittle (keyword overlap, no LLM) — and that is acceptable *precisely because it has
zero authority*. It produces a signal (the precision numerator) and nothing else. It
never blocks, never gates delivery, and feeds only the operator-facing
`GET /usher/metrics`. A brittle detector with no blocking power is the correct
pattern; the anti-pattern (brittle check WITH blocking authority) is not present.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, or race?**

- **Idempotency:** `markActed` guards `if (sig.acted) return false`, so paths (a) and
  (b) marking the same signal, or repeated calls, increment `acted` at most once per
  signal. The split counters (`acted_by_use`/`acted_by_miss`) only increment on the
  successful (first) mark.
- **Ordering on the inbound seam:** path (b) runs in the human-detector callback,
  which is chained *before* the Usher loop callback on the same `onMessageLogged`.
  It correlates the correction against signals fired on PRIOR turns (already
  persisted) — it does not race the current turn's not-yet-fired signal.
- **No shadowing:** the outbound tone-gate / dedup / ArcCheck path is unchanged;
  crediting runs after the gate passed and the send succeeded, so it cannot affect
  any block/allow outcome.

## 6. External surfaces

**Does it change anything visible to other agents, users, or systems?**

- `GET /usher/metrics` gains two additive fields (`acted_by_use`, `acted_by_miss`)
  and `acted`/`precision` now actually move. This endpoint is operator-only
  (`INTERNAL_PREFIXES`), not surfaced to end users or other agents.
- The per-topic `usher/<topicId>.json` store files gain optional `actedVia`/`actedAt`
  on signals — additive; `load()` already tolerates unknown/missing fields and old
  readers ignore them.
- No change to any message content, no new outbound traffic, nothing visible to
  peer agents. Behavior depends on conversation/topic state but is fully best-effort.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Cheap and clean: revert the commit (a normal patch release). No data migration — the
new optional fields are tolerated by existing `load()` and ignored by older binaries;
a topic file written by the new code is readable by the old code and vice-versa.
Worst case after revert: `precision` returns to its prior pinned-at-0 state (the bug
this fixes). No agent-state repair, no hot-data fix. Because the change is
observability-only, a wrong precision number cannot itself cause an outage — at most
it would mislead the rung-5 decision, which is human-gated and not part of this change.
