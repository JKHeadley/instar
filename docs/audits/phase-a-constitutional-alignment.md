
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

### Angle 5 — 0 new instances, and something more useful: the EXEMPLAR is already in-repo

Angle 5 swept health/status fields whose NAME might assert more than their computation
(`healthy`, `reachable`, `ready`, `connected`, `live`). **No new instance of the class.** But the
candidate flagged in angle 4 turned out to be the opposite of an instance — it is the pattern the
class needs, already written, already shipped:

`DoorwayRegistryReader` resolves reachability **three-valued**:

```
'not-probed-this-run' | 'not-probed-this-scope'
'not-probed-budget-refused' | 'http-5xx'   →  null    // CANNOT TELL — explicitly not false
'not-installed' | 'http-4xx'               →  false   // definitively unreachable
'malformed-response' | 'oversize-response' →  true    // the door DID answer
default                                    →  null    // unknown ⇒ null, never a guess
```

**"Not probed" returns `null`, not `false`.** Unknown returns `null`, not a guess. A door that answered
badly is still recorded as having answered, with the parse concern handled elsewhere rather than
smeared into the reachability verdict.

That is *exactly* the three-kinds-of-zero discipline this audit derived independently for counters
(`{looked, wouldAct, didAct}`), implemented for booleans, by someone else, already in the tree.

### Why this changes the Phase B recommendation

The fix for *asserts-unmeasured-state* is therefore **not a design problem — it is a propagation
problem.** The repo contains a correct, shipped exemplar; the instances are the sites that predate it
or never adopted it. That is materially cheaper than "design a solution", and it makes the
recommendation concrete:

> **Make the two-valued `available: boolean` on `IntelligenceRouter` three-valued, matching
> `DoorwayRegistryReader`: `true` (verified reachable) / `false` (verified unreachable) / `null` (not
> probed — the honest default).**

Under that shape, codex would have reported `null` rather than `true` while its token was revoked, and
the surface an operator consults for "is this door healthy?" would have said "I have not checked"
instead of "yes".

**Sweep status after 5 angles: 3 confirmed instances, 1 exemplar located, NOT converged.** The next
angle remains open — the class has produced a finding in the most recent round, so the contract
requires another.

### Angle 6 — CONFIRMED INSTANCE #4, and it attacks the anti-hallucination mechanism itself

Angle 6 swept *cause asserted by omission* — a branch emitting one status for several distinct
conditions. Most candidates were **correct**: `StaleOwnerReleaseEngine` documents *"an unreadable
feature gate reads as INACTIVE (fail dark, the safe direction)"*, which is a deliberate, named,
safe-direction choice. Those are not instances.

**`CapabilityMapper` is.** **Seven** subsystem checks share this shape (7 `catch { return false }` and 7 `if (!fs.existsSync(configPath)) return false`):

```js
check: () => {
  const configPath = path.join(this.config.stateDir, 'config.json');
  if (!fs.existsSync(configPath)) return false;          // <- CANNOT READ  => "absent"
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.messaging?.some(...) ?? false;
  } catch { return false; }                               // <- CANNOT PARSE => "absent"
}
```

Two paths report **capability ABSENT** when the truth is **could not determine**.

#### Proved non-destructively, with both sides of the boundary

Ran the exact check shape against fixture configs (never the live config):

| condition | capability truly enabled? | check reports |
|---|---|---|
| readable config | yes | `true` ✅ |
| **corrupt config** (truncated mid-object) | **yes** | **`false` — ABSENT** ❌ |
| config file absent | unknown | `false` — ABSENT ❌ |

A partial write, a truncated file, or a transient read error makes the agent report it does not have
Telegram, relationships, or monitoring — while all three are enabled.

#### Why this instance matters more than the other three

`CapabilityMapper` feeds `GET /capabilities`, which the agent constitution names explicitly:

> *"Before EVER saying 'I don't have', 'I can't', or 'this isn't available' — check what actually
> exists… It is the source of truth about what you can do. **Never hallucinate about missing
> capabilities — verify first.**"*

**The mechanism built to stop the agent falsely claiming it lacks a capability will itself falsely
report a missing capability whenever it cannot read the config.** An agent obeying the constitution
perfectly — verifying before claiming — is handed a confident false negative, and the failure is
silent, because a capability that is absent looks exactly like a capability that is off.

The safe direction here is NOT `false`. For an availability claim, the honest default is *unknown* —
the same three-valued shape `DoorwayRegistryReader` already implements.

**Sweep status after 6 angles: 4 confirmed instances, 1 exemplar, NOT converged.**

### Angle 7 — cross-boundary assertion: 0 new instances (and the near-miss is instructive)

Swept callers that convert a null/undefined callee result into a definite state
(`?? false`, `|| 'unavailable'`). 14 candidates, **0 instances**. They split three ways:

1. **Config defaults** — `opts.escalationEnabled ?? false`, `config?.alwaysRestartImmediately ?? false`.
   An absent flag defaulting to off is not an assertion about the world.
2. **Documented fail-closed** — `UpdateGate`'s `restartSafetyResolver?.(session) ?? false` (no resolver
   ⇒ restart NOT safe), `MeshRpc`'s `authorizeMandateDeliver?.(…) ?? false` (no authorizer ⇒ not
   authorized). Refusing in the absence of a positive answer is the correct direction.
3. **One near-miss worth naming.** `MultiMachineCoordinator.preferredIsHealthy` returns
   `leaseCoordinator?.isHolderHealthy(m) ?? false` — "peer unhealthy" when there is no coordinator to
   ask, which *reads* like instance #4's shape. It is not. `LeaseCoordinator.isHolderHealthy`'s own
   contract: *"a non-preferred machine defers to its preferred peer ONLY while this is true, so a
   frozen/down/released preferred never strands coverage."* `false` means **stop deferring and take
   over** — the coverage-preserving direction.

**The discriminator this angle produced:** an unmeasured-state assertion is only a defect when the
asserted value is the one that CAUSES action or inaction wrongly. `false` meaning "refuse" is safe;
`false` meaning "this capability is absent" (instance #4) or `true` meaning "this door works"
(instance #3) is not. **The class is not "a boolean where unknown is possible" — it is "a boolean whose
unknown collapses to the CONSEQUENTIAL value."** That is a materially tighter definition than the one
Round 5 swept with, and it explains why Round 5's three angles found nothing: they searched for the
shape, not for the consequence.

**Sweep status after 7 angles: 4 confirmed instances, 1 exemplar, 1 tightened definition. NOT
converged** — the contract needs a clean round with the *new* definition, since angles 1-5 were run
with the looser one and would not reliably have recognised instances #3 or #4.
