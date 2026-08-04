
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

---

# NAMED OPEN DECISIONS carried into Phase B

Recorded here so they cannot rot as implicit intentions. Each is a decision someone must MAKE, not a
task someone must do.

## OD-1 — Does the placement policy require the managed peer-execution runtime?

**Node:** placement (worker lanes on the laptop)
**Status:** OPEN. Ruled 2026-08-04 (Observer cycle four): do **not** re-enable unilaterally.

`multiMachine.peerExecution.enabled` is `false` while its own config carries `requiredForReadiness:
true`. It is classified **load-bearing**, `criticalPath: "autonomous execution on a paired peer
machine"`, and it gates the managed mutual-SSH runtime. It was disabled on **2026-08-01T12:57:02Z**
together with `meshTransport.recoveryProbeEnabled`; the guard-posture tripwire raised an attention item
at the time, which **sat OPEN and unacknowledged for three days** until acknowledged on 2026-08-04
under this ruling.

**The decision:** placement may ride the **session pool** (currently stage `rebalance`) rather than the
managed runtime. Until that is settled, re-enabling is a guess.

**What is already known, so the decision is not re-litigated from scratch:**
- Raw SSH between the two machines works — used continuously throughout the 2026-08-04 window.
- So connectivity is NOT the open question; only whether the MANAGED runtime is on the placement path.
- The laptop's revival queue — the prerequisite the Observer named for placement — is now repaired and
  **verified running** (two distinct ticks 60 s apart), so this is the remaining placement blocker.

**Decision owner:** Justin, via the Observer.

## OD-2 — The three load-bearing guard gaps: graduate, soak, or record an owned accept?

**Status:** OPEN, same ruling — recorded, not unilaterally re-enabled.

`multiMachine.meshTransport.recoveryProbeEnabled` · `multiMachine.sessionPool.inboundQueue.enabled` ·
`multiMachine.sessionPool.staleOwnerRelease.enabled`.

The guard framework itself offers exactly three resolutions (graduate / let it soak out / record an
owned accept with reason+owner). **Leaving them flagged is not one of them** — an indefinitely-open
load-bearing gap is the state the classification exists to make impossible.

## OD-3 — Can the CI-and-PR-context guards be verified by a real CI run?

**Status:** OPEN (carried from the Phase A close). 10 guards, currently positional deferrals.

## OD-4 — Adopt the `{looked, wouldAct, didAct}` counter schema?

**Status:** OPEN (carried from the Phase A close). **Supporting evidence: exactly 1 guard in 90 can
answer "did you ever actually act?"** — see the Round 6 instrumentation measurement.

## OD-5 — Make availability three-valued to match the in-repo exemplar?

**Status:** OPEN (new, Round 6). `IntelligenceRouter`'s `available: boolean` measures *binary presence*
and is read as *reachability*; `DoorwayRegistryReader` already implements the correct three-valued
shape (`true` / `false` / `null` for not-probed). **This is a propagation decision, not a design one.**

---

## OD-6 — Why does the interactive pool hold zero sessions? (bounded unknown, 2026-08-04 15:45Z)

**Status:** OPEN. Blocks the Phase A close condition (one real judgment call succeeding through the
pool). Recorded as a bounded unknown rather than a guess.

**What is established:**

- Gating calls now genuinely REACH the pool: `MessagingToneGate` shows 4 calls / 4 errors against
  `claude-code / interactive-pool`, with `shed: 0` — real errors, not capacity sheds.
- The swap-budget fault is resolved: **2** `swap-attempt-timeout` events before the 15:11 restart,
  **0** after.
- The pool holds **0 tmux sessions**, and **no spawn attempt is logged at all** since that restart.

**Hypotheses ELIMINATED (each checked, not assumed):**

| hypothesis | why it is not the cause |
|---|---|
| the memory gate is starving pool spawns | `pool.spawnOne()` calls `tmux new-session` **directly**; it never passes through `evaluateRerouteGate`. The gate IS refusing *job* reroutes ("host memory pressure is high") — a real, separate fault, and option C's subject — but not this one. |
| the host-wide spawn cap is shedding them | cap 8, 1 live, 7 available, `saturated: false`; and the tone-gate rows show `shed: 0`. |
| a Claude REPL cannot reach ready right now | spawned one by hand: **ready in ~5 s**. |
| the pool's working directory is missing | `.instar/intelligence-pool` exists; a tmux spawn with that `-c` succeeds. |

### ⭐ CONFIRMED FROM SOURCE — a memoised rejected start permanently disables the pool

```js
let startPromise = null;
const ensureStarted = async () => {
    if (!startPromise) {
        startPromise = pool.start();
    }
    await startPromise;          // <- NO rejection handling, and no reset
};
```

**There is no rejection path.** If `pool.start()` rejects even once:

1. `startPromise` is left holding a **rejected** promise — non-null.
2. Every later `ensureStarted()` sees it as truthy, **skips the restart entirely**, and re-awaits the
   same rejection, throwing immediately.
3. No spawn is attempted, so **nothing is logged** — the failure is invisible after the first instant.
4. This persists for the **entire process lifetime**. Only a server restart clears it.

**This accounts for every observation, with nothing left over:** 0 sessions, 0 spawn attempts logged,
4 real errors with `shed: 0`, a REPL that spawns fine by hand, and a condition that did not self-heal
across 400 s of watching.

**Severity.** One transient failure at first-use — a momentary resource blip, a slow spawn, a leftover
session — permanently removes the interactive-pool door for that process. Under
`subscriptionPath.mode: force`, that door is the fallback the entire gating layer depends on when the
primary framework is down. Which is exactly the state this agent is in (codex 401).

**The pattern is the audit's own class, one layer up.** `ensureStarted` treats "I already tried" as
"the answer is settled" — the same shape as asserting a state you did not re-measure. A retry-on-reject
(or clearing `startPromise` in a `catch`) is the whole fix.

**Recorded as CONFIRMED-from-source, NOT as a shipped fix** — per the Phase A scope ruling, genuine
builds are deferred to Phase B. Fifth blocker in the serial chain, and consistent with the lesson:
each was invisible until its predecessor was fixed.
