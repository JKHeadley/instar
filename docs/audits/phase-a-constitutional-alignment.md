
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
