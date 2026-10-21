# Side-Effects Review — reap notice fallback destination

**Slug:** `reap-notice-fallback-destination`
**Date:** `2026-10-20`
**Author:** Echo (autonomous, 24h run on topic 61449)
**Tier:** 1

## Summary of the change

`ReapNotifier`'s lifeline-bound notices (unbound sessions, the cross-topic index)
resolved their destination solely through `lifelineTopic()`, which is
Telegram-shaped. On a Slack-only agent that is always null, so every such notice
was recorded `no-topic` / "lifeline topic not configured" and dropped — the layer
that exists to prevent silence, silent. Observed on the indra agent, 2026-10-20.

Adds two optional deps: `fallbackNotify` (wired to the server's notification
gateway, which already reaches Telegram AND/OR Slack) and `raiseNoDestination`
(one attention item when there is no destination at all), plus a loud log line in
that same case.

## Decision-point inventory

No LLM decision points. Destination resolution is deterministic.

## Blast radius

- `ReapNotifier` — the `lifeline == null` branch only. The lifeline-present path
  is untouched; an install with neither new dep wired records `no-topic` exactly
  as before (test).
- `server.ts` — wires both deps. `fallbackNotify` reuses the SAME `notify()`
  gateway the notifier's `send` dep already uses, so no new transport, no new
  formatting path, and the existing quiet-hours/batcher behaviour applies.

## Reversibility

Reversible by revert. Both deps are optional; no state, no schema, no config key.

## Failure modes considered

- **Double-sending.** The fallback runs ONLY when `lifelineTopic()` is null, so it
  can never race the normal path.
- **A throwing gateway.** Caught; the notice is still recorded and the gap still
  reported (test). A failing fallback must not also lose the audit record.
- **Claiming delivery that did not happen.** `fallbackNotify` returns whether a
  destination existed, and the recorded outcome follows that return rather than
  assuming success — the same honesty problem as the stuck-input work in this run.
- **Noise.** One attention item on a fixed id, and the branch is only reachable on
  an agent with no system topic at all.
- **The catch-22.** An agent with no Telegram adapter cannot raise a Telegram
  attention item either, which is why the console warning is unconditional in that
  branch. Stated rather than papered over: on such an agent the log is the only
  trace, and that is still strictly better than the previous nothing.

## Verification

5 new unit tests (`tests/unit/reap-notice-fallback-destination.test.ts`) covering
all three branches plus the throwing gateway and the not-wired install. The
existing `reap-notifier` suite (28 tests) stays green, including its
`records no-topic` case. Full lint clean. `tsc --noEmit` clean.

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`
**Closure:** `n/a`
**Reason:** no self-triggered loop is added. The change runs inside the existing
flush, on a branch that was previously a drop, and the one action it adds is a
single attention item on a fixed id.
