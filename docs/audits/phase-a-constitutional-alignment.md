
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

### The finding, stated plainly — CORRECTED 2026-08-04 17:10Z, and it is worse than first published

> **NOT ONE guard in ninety can answer the question "did you ever actually act?"**

**The originally published figure was "exactly ONE". That was wrong, in the conservative direction.**
It came from a key-name heuristic (`count|fired|acted|would|attempts|blocked|caught`) matching
`jobCount` — which is a count of JOBS THAT EXIST, not of actions taken.

Re-verified by a different method: enumerating every DISTINCT key present in any guard's runtime block
across the whole population, and reading them.

| runtime key | guards exposing it | what it tells you |
|---|---|---|
| `enabled` | 26 | a config flag — not evidence of anything happening |
| `lastTickAt` | 20 | liveness — "I ran" |
| `tickAgeMs` | 19 | liveness |
| `stale` | 16 | liveness |
| `dryRun` | 13 | a mode flag |
| `verdictUnknown` / `verdictUnknownReason` | 1 | one guard, and it is a state not a count |
| `jobCount` / `pausedJobCount` | 1 | the scheduler's inventory — not its actions |

**There is no `fired`, no `caught`, no `blocked`, no `wouldAct`, no `didAct` — anywhere in the
population.** Every key present answers *am I alive?* or *how am I configured?*. **None answers *what
have I done?***

**So the corrected figure is ZERO of 90, not 1 of 90.** The argument for the counter schema is
therefore stronger than published, not weaker: this is not a sparsely-instrumented population, it is an
**uninstrumented** one for the purpose the audit cares about.

*Method note: this was caught by re-verifying a published headline with a DIFFERENT method than the one
that produced it. The first method's flaw — a regex matching a plausible-looking key name — is exactly
the class this audit catalogues, committed by the auditor, and it survived one publication cycle.*

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

### OD-6 mechanism, completed — how one slow spawn kills the door for a whole process

```js
async start() {
    await this.killStaleSessions();                    // agent-prefix scoped
    const promises = [];
    for (let i = 0; i < this.config.poolSize; i++)     // poolSize default 2
        promises.push(this.spawnOne());
    await Promise.all(promises);                       // ANY ONE failure rejects the whole start
}
// spawnOne: throws `Pool session <id> did not reach ready state in 30s`
```

Composed with the memoised `ensureStarted`, the full chain is:

1. **One** of the two spawns fails to reach ready inside **30 s**.
2. `Promise.all` rejects — the *other* session having spawned successfully does not help.
3. `startPromise` retains that rejection **forever** (no catch, no reset).
4. Every later call re-awaits it, attempts no spawn, and logs nothing.
5. The door is gone until the process restarts.

**A 30-second timeout on a machine under memory pressure is the whole exposure.** The reroute gate was
reporting `host memory pressure is high` at 15:11:08 — the same window the first `pool.start()` would
have run. That the trigger was a slow spawn is **inferred** (the timeout itself is not logged);
the *defect* — that any single transient spawn failure is permanent — is **confirmed from source**.

#### The same `killStaleSessions()` explains the earlier incident

Its comment: *"our prefix is agent-scoped, so anything matching it is OURS from a dead process — kill
before spawning fresh."* The reasoning holds for the SERVER's own restart. It does **not** hold for a
second process constructing its own adapter: the `_smoketest` built a default-config adapter whose
prefix matched the live server's sessions, so "anything matching it is ours" reaped a session belonging
to a *running* peer process. **The already-filed harness defect and this pool defect share one root** —
prefix-scoped ownership with no liveness check on the owner.

#### Why this is the highest-value single finding of the sweep

Three properties compound:
- **Silent** — after the first instant it logs nothing, because nothing is attempted.
- **Permanent** — process-lifetime, no self-heal, no backoff, no retry.
- **Load-bearing** — under `subscriptionPath.mode: force` this door is the fallback the whole gating
  layer depends on when the primary framework is down.

An agent can therefore lose its entire internal-judgment fallback to one transient blip, and every
observable surface stays quiet about it. **That is the exact failure shape this audit was commissioned
to find**, arrived at from the opposite direction — not by auditing a guard, but by chasing why a
guard's evidence would not appear.

---

## Angle 8 — 0 new instances, a SECOND exemplar, and OD-6 bounded as a singleton

### The memoised-promise shape is unique in the tree

`grep -rnE "if \(!\w*[Pp]romise\)" src/` returns **exactly one** hit:
`anthropic-interactive-pool/index.ts:82` — the OD-6 site. **OD-6 is a singleton, not a family.** That
is worth knowing before anyone scopes a Phase B fix: it is a one-site change, not a sweep.

### Second exemplar: `TopicProfileResolver.isLaunchable`

Swept caches that could retain a FAILURE indefinitely. `launchabilityCache` looked like the shape —
caching whether a framework can launch. It is the opposite:

```js
const cached = this.launchabilityCache.get(framework);
if (cached && Date.now() - cached.at < LAUNCHABILITY_TTL_MS) return cached.ok;   // TTL'd
let ok = true;                                                                    // fails toward YES
try { … fs.existsSync(bin) … } catch { /* deliberate fail-OPEN */ }
```

Its own comment states the discipline better than the audit did:

> *"Fail toward 'launchable' whenever the check cannot actually verify absence: this check is a cheap
> SIGNAL whose only job is to catch a provably-missing binary… a pin must never be re-routed on the
> checker's own blind spot. Genuinely broken CLIs are the §10.4 breaker's authority."*

Three correct properties at once: a **TTL** so no verdict is permanent; **fail-open** because the
consequential direction is "don't reroute"; and an explicit **hand-off of authority** to the component
that can actually decide. It is signal-vs-authority and don't-assert-what-you-didn't-measure, applied
together, deliberately.

**Note the contrast with instance #3** (`IntelligenceRouter.available`, which also concerns whether a
framework is usable): one asks the same question and answers it honestly; the other answers it with a
name it cannot support. **They are in the same codebase, about the same subject.** That is the clearest
possible evidence for the propagation reading — the knowledge exists here; it is unevenly applied.

### Convergence status

| angle | subject | new instances |
|---|---|---|
| 1-3 (round 5) | cause strings, fixed literals, user templates | 0 *(loose definition)* |
| 4 | computed availability booleans | **1** (#3) |
| 5 | health/status field naming | 0 — exemplar #1 found |
| 6 | cause asserted by omission | **1** (#4) |
| 7 | cross-boundary assertion | 0 — **definition tightened here** |
| 8 | memoised/cached failures | 0 — exemplar #2 found; OD-6 bounded as singleton |

**Two consecutive clean angles (7, 8) under the TIGHTENED definition.** The contract asks for a clean
re-sweep before declaring convergence, and angles 1-5 ran under the looser definition — they would not
reliably have recognised #3 or #4. **So: approaching convergence, not converged.** The honest next step
is re-running angles 1-3 with the tightened definition ("a boolean whose unknown collapses to the
CONSEQUENTIAL value"), not declaring done on two clean rounds.

---

## ASSERTS-UNMEASURED-STATE — sweep CONVERGED (this class, this surface)

Angles 1-3 were re-run under the tightened definition rather than trusting their original clean
results, because they had been run under the looser one and would not reliably have caught #3 or #4.

| angle | subject | result under the TIGHTENED definition |
|---|---|---|
| 1 (re-run) | a stated cause that DRIVES a decision | **0** — every `reason:` sits in an audit call carrying the measured evidence beside it (`not-owner` + `observedStatus`, `stale-epoch` + `observed`/`sent`, `cas-lost` + `casReason`) |
| 2 (re-run) | fixed status literals with consequence | **0** — all reason-carrying refusals are measured conditions; the one legacy fail-open (`conversationBindGate`) is a deliberate staged migration: scoped to the legacy path, time-bounded by a deploy-stamp grace window, and instrumented with a straggler attention item |
| 3 (re-run) | defaults that DISABLE rather than label | **0** — `SwapAntiThrash` defaults `enabled: true, dryRun: true`; a brake defaulting ON and OBSERVE-ONLY is the safe direction |
| 4 | computed availability booleans | **1** — instance #3 |
| 5 | health/status field naming | 0 — exemplar #1 |
| 6 | cause asserted by omission | **1** — instance #4 |
| 7 | cross-boundary assertion | 0 — definition tightened here |
| 8 | memoised / cached failures | 0 — exemplar #2; OD-6 bounded as a singleton |

**Final round: 0 new findings, across a re-run of every prior angle plus two new ones, under one
consistent definition.** The sweep is CONVERGED for this class over the agent-observable source surface.

### Dispositions — every instance closed

| # | instance | disposition |
|---|---|---|
| 1 | `SessionManager.currentMemoryPressure` asserted `critical` from raw free pages | **fixed** — PR #1850, shipped |
| 2 | `LlmCircuitBreaker` hardcoded `provider rate-limited` for all trip causes | **fixed** — PR #1851, shipped 1.3.1125 |
| 3 | `IntelligenceRouter.available` measures binary presence, read as reachability | **deferred:OD-5** — propagate the three-valued exemplar |
| 4 | `CapabilityMapper` reports capability ABSENT when it cannot read config (7 checks) | **deferred:OD-7** (new, below) |
| 5 | `anthropic-interactive-pool` memoised rejected `startPromise` | **deferred:OD-6** — singleton, one-site fix |

### OD-7 — `CapabilityMapper` should distinguish "absent" from "cannot tell"

**Status:** OPEN. Seven checks return `false` on both a missing config file and a JSON parse failure.
Proved against fixture configs: a genuinely-enabled capability with a truncated config reports ABSENT.
Feeds `GET /capabilities`, the surface the constitution names as the source of truth with the
instruction *"never hallucinate about missing capabilities — verify first"*. **An agent obeying that
rule perfectly is handed a confident false negative.** Same three-valued fix as OD-5.

### What the convergence actually licenses

**Only this:** no further instance of this class is findable by SOURCE-PATTERN search over `src/`.
It does NOT license "the codebase no longer asserts unmeasured state" — three of the five instances
were found by watching RUNTIME behaviour diverge from a surface's claim (#2 from a log line, #3 from a
health endpoint contradicting live calls, #5 from an absence of expected log output). **A pattern sweep
cannot find those; only using the system can.** That asymmetry is the sweep's honest limit and belongs
in the next phase's method, not in a footnote.

---

# ⚠️ RETRACTION — OD-6's CAUSAL claim was wrong. The instance stands only as a LATENT risk.

**Measured 2026-08-04 16:35Z.** I published OD-6 as *"CONFIRMED FROM SOURCE — a memoised rejected start
permanently disables the pool"* and stated it accounted for every observation "with nothing left over".
**The pool then recovered on its own**, without a restart:

- pool sessions spawned at **15:45:39Z** and **15:52Z** — after I declared the door permanently dead
- server log, 15:45:39Z: `[subscription-path] serving internal intelligence via subscription-pool`
- current interactive-pool metrics: **25 calls, 1 error, 24 successes**

**A poisoned `startPromise` cannot recover without a process restart. There was no restart. Therefore
it was not poisoned.**

## What was actually happening

`ensureStarted()` is **lazy** — the pool starts on FIRST ALLOCATE, not at boot. Between the 15:11
restart and 15:45 nothing had genuinely invoked it, so it had never started. That is not a fault; it is
the documented design (*"Start the pool lazily on first allocate"*). The handful of earlier errors were
calls arriving before or during that first start, not evidence of a permanent condition.

## What survives, and what does not

| claim | status |
|---|---|
| `ensureStarted` has no rejection handling and no reset (`if (!startPromise) startPromise = pool.start()`) | **TRUE** — verified from source, unchanged |
| A rejection there WOULD be permanent for the process lifetime | **TRUE** by reading — the code has no catch |
| A rejection HAD occurred and was the cause of the empty pool | **RETRACTED — false** |
| `start()`'s `Promise.all` means one slow spawn rejects the whole start | **TRUE** — but latent, not observed firing |

**OD-6 is re-classified from a confirmed active defect to a LATENT RISK**: a real robustness gap that
has not been observed triggering. Its severity argument (silent, permanent, load-bearing) is a
consequence of the code shape and still holds *if* it fires. Its evidence of *having* fired is
withdrawn.

## The failure, named plainly

**I asserted a cause I inferred rather than measured — inside the audit whose entire subject is
components that assert what they did not measure.** Every ingredient of my own catalogue is present:

- I had a mechanism that *could* explain the observation, and stopped looking (method lesson #23's shape).
- I mistook "accounts for every observation" for "is the only thing that accounts for every
  observation" — the alternative (lazy start, not yet invoked) explains the same evidence and is
  simpler.
- **I did not apply the absence rule** — *before believing something is broken, prove the check could
  have shown otherwise.* A pool that has never been asked to start looks exactly like a pool that
  failed to start. **That distinction is literally the three-kinds-of-zero finding, and I walked past
  it in my own sweep.**

**New method lesson #24: "confirmed from source" is not confirmation of CAUSE.** Reading a code path
that *could* produce an outcome proves the path exists, never that it ran. Confirming a mechanism and
confirming a diagnosis are different acts, and the word "confirmed" hides the gap. A causal claim needs
a runtime observation of that path being taken — which for OD-6 would be a logged rejection, and there
was none.

## Consequence for the close condition

The close condition is now ALSO satisfied through the POOL, not only the primary door: **24 successful
interactive-pool calls**. The stricter original reading of the Observer's condition — *one real
judgment call succeeding live through the pool* — is met.

---

## Exemplar #3, found in a live log line — and a real gap underneath it

**2026-08-04 16:31Z**, observed while checking post-recovery health:

```
[orphaned-work-sentinel] enumeration FAILED — stranded-work count is UNKNOWN, not zero:
worktree enumeration failed for repo "/Users/…/agents/echo":
Command failed: git -C /Users/…/agents/echo worktree list --porcelain
fatal: not a git repository
```

### Why it is an exemplar

> **"stranded-work count is UNKNOWN, not zero"**

That clause, in a WARN line, is the entire three-kinds-of-zero discipline stated in six words by a
component that could trivially have logged `stranded: 0` and moved on. It distinguishes *I looked and
found none* from *I could not look* **at the moment of failure**, in the surface a human actually
reads. The other two exemplars implement the discipline in code; this one **speaks** it.

### The real gap underneath

The probe is wrong for this agent's shape: it runs `git worktree list` against the **agent home**,
which is not a git repository — the worktrees live *under* it, each its own checkout, and the home is
plain filesystem. So on this agent the sentinel is **structurally unable to enumerate stranded work**,
permanently, not transiently.

**And that is exactly why the honest reporting matters.** A component that reported `0` here would
produce a standing false all-clear on stranded work — the failure mode being audited — indefinitely,
with nothing to notice it. Instead the defect is loud on every run.

**Recorded as OD-8** (open): the orphaned-work sentinel cannot enumerate on an agent whose home is not
a repo; it should enumerate the worktree roots beneath the home, or declare the agent out of scope.
Its current behaviour is *correct-but-blind* — the safest possible failure, and still a blind spot.

### Score after this

Three exemplars, all in-repo, all pre-existing: `DoorwayRegistryReader` (three-valued reachability),
`TopicProfileResolver.isLaunchable` (TTL + fail-open + authority hand-off), and now
`orphaned-work-sentinel` (explicit UNKNOWN-not-zero). **The discipline is not missing from this
codebase; it is unevenly applied.** That is the single most actionable conclusion of the sweep, and it
is now supported by three independent examples rather than one.

---

## OD-9 — the swap budget cannot cover the pool's worst case (my own fix is partial BY CONSTRUCTION)

**Correcting my own report.** After applying the sanctioned per-framework swap timeout I reported
*"2 swap timeouts before the restart, 0 after"*. That was true when measured (~15:20). **It is no longer
true: two more occurred, at 15:52:08Z and 16:31:19Z.** Re-measuring a claim I had already published is
what surfaced it.

### The arithmetic

| budget | value |
|---|---|
| pool `allocateTimeoutMs` | 60,000 ms |
| pool `maxPromptWaitSeconds` | 120 s |
| **pool worst case (allocate + prompt)** | **180,000 ms** |
| swap budget I set | 120,000 ms |
| `DEFAULT_SWAP_ATTEMPT_TIMEOUT_MAX_MS` (**hard clamp**) | **120,000 ms** |

**The swap budget's maximum permitted value is 120 s. The pool's own worst case is 180 s.** A
legitimately slow call — one that waits for an allocation and then uses its full prompt budget — cannot
fit inside the largest swap budget the router allows.

**So the fix is partial by construction, not by my choice of value.** I chose the clamp maximum; there
was no higher value available. In practice most calls fit comfortably (2 timeouts in ~100 minutes
against hundreds of successful calls), but the tail is structurally unreachable through this knob.

### Why this is a finding rather than a tuning note

Two independently-set budgets govern one operation, and **the ceiling on the outer one is lower than
the floor-plus-worst-case of the inner one.** Neither component is wrong on its own terms: the pool's
120 s prompt wait is reasonable for a TUI, and a 120 s clamp on a swap attempt is reasonable
backpressure. The defect is that **nothing reconciles them**, so the composition has a permanently
unreachable region that neither owner can see from their side.

**This is the cross-store-coherence class applied to timeouts** — two stores of the same truth
("how long may this take?") with no declared agreement invariant. The `Cross-Store Coherence Is an
Invariant` standard names exactly this shape for data; it has no timeout analogue.

### Proposed resolution (for Phase B, not built)

Either raise the clamp above the composed worst case, or lower the pool's composed worst case below the
clamp, **and add an assertion that the two cannot drift apart again** — the reconciliation is the
deliverable, not the number.

### Honesty note

I reported "0 after" from a single measurement taken minutes after the change, during a window when the
pool was not even being invoked. **That is method lesson #22 again — the absence check applies hardest
to a claim you have already published**, because nobody re-checks it for you.
