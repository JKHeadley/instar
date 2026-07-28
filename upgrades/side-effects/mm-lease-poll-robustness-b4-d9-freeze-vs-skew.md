# Side-Effects Review — B4-D9 clock-skew alarm: freeze-vs-skew disambiguation

**Spec:** `docs/specs/multimachine-lease-poll-robustness.md` (approved) — B4, Decision 9.
**Files:** `src/core/clockSkewAlarm.ts`, `tests/unit/clockSkewAlarm.test.ts`.

## What changed

`evaluateClockSkew` gains an optional `recentLocalStarvationAgeMs` input (+ a
`starvationFreshnessMs` window, default 30s). When THIS machine's event loop has
recently starved, a large apparent peer offset is attributed to the local freeze
(`blame: 'local-freeze'`) and the peer-skew alarm is **suppressed** rather than
raised. Pure function; no new I/O, no consumer wired yet (the measurement wiring
that feeds `recentLocalStarvationAgeMs` from the SleepWakeDetector drift signal is
the next step under the same spec).

## Why (live evidence, 2026-06-20, topic 13481)

The agent's own server briefly wedged: a live-tail+mesh-rpc flap storm starved the
event loop ~171s (SleepWakeDetector drift burst). Mesh timestamps set *before* the
freeze were verified *after* it and were rejected as `stale-timestamp` — even though
the two machines' clocks were measured **1s apart** (Laptop vs Mini), i.e. perfectly
synced. The prior alarm logic would read that large apparent offset and raise a
"peer clock skew" alarm — a false positive that would point the operator at a
non-existent peer-clock problem. This guard makes the alarm honest under the exact
condition that produced it.

## The 8 questions

1. **Over-block.** It suppresses a *real* skew alarm while a local starvation is
   fresh (default 30s window). Honest worst case (per 2nd-pass): a *repeating* freeze
   STORM — like the 171s flap storm that motivated this — keeps re-stamping a small
   `recentLocalStarvationAgeMs`, so suppression persists for the **full duration of
   ongoing local freezing**, not a single window. That is still the correct safe
   direction (you do not want to finger-point a peer's clock mid-storm), and it
   self-heals the moment the storm ends and the offset re-alarms. Never permanently
   hidden.
2. **Under-block.** It does not detect skew that *coincides* with a freeze (both true
   at once). By design we cannot distinguish them during the freeze, so we defer; the
   persistent-offset re-alarm after the window covers the real-skew case.
3. **Level-of-abstraction fit.** Correct layer: a pure decision helper. The freeze
   signal is owned by SleepWakeDetector (its own surface); this helper merely *reads*
   its age and refuses to mis-attribute. It does not duplicate freeze detection.
4. **Signal vs authority.** SIGNAL-ONLY, unchanged. It never gates, never widens the
   MeshRpc reject (replay-safety preserved), never pushes a notification. Per the
   operator constraint (topic 13481, this session) the alarm surfaces only on
   `/guards` + logs — a pull surface — never a Telegram topic.
5. **Interactions.** Complements, does not shadow: the SleepWakeDetector still owns
   freeze detection; this only prevents the skew alarm from double-counting a freeze
   as skew. No race (pure function of its inputs).
6. **External surfaces.** None new. Optional input is back-compatible (undefined →
   byte-identical prior behavior, proven by a test).
7. **Multi-machine posture.** Machine-local BY DESIGN: the freeze it guards against is
   a property of THE LOCAL event loop on the machine running the check; the input is
   read from that machine's own SleepWakeDetector. Each machine evaluates its own
   skew alarm; no replication needed (the verdict is about *this* machine's clock vs a
   peer, computed locally on both ends).
8. **Rollback cost.** Trivial: omit the new input and behavior reverts exactly (the
   default `?? 30_000` and the `undefined` short-circuit make it inert when unfed).
   No migration, no state.

## Second-pass

Required (touches a "guard"/alarm decision on the lease/recovery path).

**Reviewer verdict (independent):** *Concur with the review.* The freeze branch is
correctly gated behind the `!alarming` early-return (clearing a genuine alarm during
a fresh local freeze is the intended safe-direction behavior, self-healing once the
freeze ages out); back-compat is byte-identical on undefined input; the
in-tolerance-no-spurious-verdict case is covered. The reviewer's one doc nit — that a
repeating freeze storm suppresses for the storm's full duration, not a single window —
is folded into Q1 above. No code fix required to ship.
