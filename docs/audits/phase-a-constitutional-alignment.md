
---

## Round 6 — the definitive instrumentation measurement (supersedes the 7-of-38 estimate)

Measured 2026-08-04 13:45Z on the live Mini via `GET /guards`, over the **full 90-guard population**
rather than the 38-route sample used earlier.

| measure | count | share |
|---|---|---|
| guards tracked | 90 | — |
| `runtimeReason: not-instrumented` | **62** | **69%** |
| runtime-enriched (report ANY runtime state) | 26 | 29% |
| …of those, reporting only a **tick/heartbeat** | 20 | — |
| …of those, exposing an **act / would-act counter** | **1** | **1.1% of all guards** |

### The finding, stated plainly

> **Exactly ONE guard in ninety can answer the question "did you ever actually act?"**

Everything else can answer at most *"am I alive?"* — and 69% cannot answer even that.

This supersedes the earlier "7 of 38 guard-shaped routes expose effectiveness counters (18%)". That
figure was measured over routes; this is measured over the guard population itself and is both larger
and worse.

### Why this is THE supporting evidence for the three-counter schema

Recall the A0 finding: `on-confirmed` means **the guard reports a heartbeat** — it is rung 2 evidenced
by a pulse, not rung 3. The `effective` distribution confirms the shape of the problem:

| effective | count | what it actually means |
|---|---|---|
| `on-unverified` | 40 (44%) | on, and nothing observes whether it fires |
| `on-confirmed` | 20 (22%) | on, and it has a pulse — **still not evidence it ever caught anything** |
| `off` | 18 (20%) | — |
| `on-dry-run` | 11 (12%) | cannot bite by construction |
| `on-blind` | 1 (1%) | — |

So the tier the system trusts most (`on-confirmed`, 20 guards) is trusted on a heartbeat, and only one
guard anywhere emits the counter that would convert that trust into evidence.

**`{looked, wouldAct, didAct}` is not a nice-to-have.** It is the difference between a population where
1 guard can be evaluated and one where 90 can — without staged faults, without injection, without a
throwaway-agent harness. It is the single highest-leverage change in the entire Phase B backlog, and
this table is the number to put in front of the decision.

### Honest limits of this measurement

- It counts **exposure**, not correctness: a guard emitting a counter could still be counting the wrong
  thing. Exposure is necessary, not sufficient.
- The act/would-act detection is a **key-name heuristic** over the runtime blocks (`count|fired|acted|
  would|attempts|blocked|caught`). A guard exposing an effectiveness counter under an idiosyncratic key
  would be missed — so **1 is a floor, and the true figure could be marginally higher**. It cannot be
  materially higher: 62 of 90 report no runtime block at all, which no naming convention can rescue.
- Single machine (Mini). The laptop's population may differ; the per-machine amendment applies.

---

## Round 6 sweep — angle 4 (computed availability booleans) CONFIRMS the class

Round 5 ran three angles over cause STRINGS and concluded *asserts-unmeasured-state* was "an outlier,
not a pattern". It also named the blind spot it could not see: **a cause asserted by a computed field
rather than a string.** Round 6 ran that angle. It found an instance immediately.

### The instance, confirmed FROM SOURCE (not inferred from behaviour)

`GET /intelligence/routing` reports `available: true` for `codex-cli` on every component while every
codex call returns `401 refresh_token_invalidated`. The router's own comments say why:

| location | comment |
|---|---|
| `IntelligenceRouter.ts:66` | *"When a routed framework's provider is unavailable (**binary missing**)…"* |
| `IntelligenceRouter.ts:178` | *"Returns null when that framework's **binary isn't available**."* |
| `IntelligenceRouter.ts:239` | *"null = built but unavailable (**binary missing**)"* |

**Availability is defined as *the binary exists*, in three places, by design.** It is not a claim about
whether the door opens — but it is *named* `available`, and it is *read* as "this door works".

This is not a bug in the sense of a mistake; it is a **measurement whose name overstates it**, which is
exactly the class. The consequence was real: with codex 100% failing, the surface an operator would
consult to ask "is codex healthy?" answered yes, for every component, throughout.

### What this does to the Round 5 verdict

**Round 5's "outlier, not a pattern" is WITHDRAWN as premature.** The class now has:

1. `SessionManager.currentMemoryPressure` (pre-fix) — mis-measured, asserted `critical`
2. `LlmCircuitBreaker` OPEN log (pre-fix) — measured nothing, asserted `provider rate-limited`
3. `IntelligenceRouter` availability — measures binary presence, named/read as reachability

Three confirmed instances, all on live critical paths, all found within one session. **A "clean" sweep
that missed instance 3 was clean only about the surface it searched** — and its own blind-spot
declaration predicted precisely where the miss would be. That the named blind spot then produced the
counterexample is the strongest available evidence that naming blind spots is load-bearing, not
ceremony.

### Sweep status: NOT converged, and now with a positive finding

| round | angles | new confirmed instances |
|---|---|---|
| 5 | 3 (cause strings, fixed literals, user templates) | 0 |
| 6 | 1 (computed availability/health booleans) | **1** |

A round that finds something is a round that must be followed by another. **The next angle is
health/status fields whose NAME asserts more than their computation** — `healthy`, `reachable`,
`ready`, `ok`, `connected` — checked against what each actually tests. `DoorwayRegistryReader:114`
(*"parse-drift on a door that DID answer → stays reachable:true"*) is a candidate to examine: it may be
a deliberate, documented exception rather than an instance, which is itself worth recording.
