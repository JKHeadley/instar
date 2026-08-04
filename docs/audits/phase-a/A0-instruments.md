# A0 — INSTRUMENTS. Three-rung audit, Phase A ground truth

**Run:** `run-mse33vhj-508c345f` (topic 29723, window #6, started 2026-08-04T03:13:56Z)
**Measured:** 2026-08-04T03:15Z → 03:40Z, this machine (Mac Mini, port 4042) + Laptop where stated.
**Binding rule:** verdicts are three-rung — `exists` / `wired` / `effective` — and **only `effective` licenses use.**
**Standing rule applied throughout:** before believing something is absent or fine, prove the check could
have shown otherwise. Every ❌ and ✅ below names its control.

> ## ✅ CONVERGED — 6 rounds, 28 instruments, 10 effective
>
> Per the node contract's rule 3, this audit ran to convergence rather than stopping at one pass.
> **Round-by-round yield is the evidence, not the claim:**
>
> | round | instruments added | new fundamentals |
> |---|---|---|
> | 1 | 17 | the dead backstop · the memory sibling · the founding-case correction |
> | 2 | +7 | **the decision-quality meter: 750 decisions, 0 graded** — the biggest finding in the audit |
> | 3 | +1 | token reconciliation → **a correction to a number I had given the operator** |
> | 4 | +3 | **passport vs Threadline disagree on my own fingerprint** |
> | 5 | 0 | echo — nothing that changes a Phase A verdict |
> | 6 | 0 | echo |
>
> **Two consecutive echo rounds ⇒ converged.** The bar was pre-stated before round 5 ran.
>
> ⚠️ **The single strongest argument for the rule:** pass 1 missed the decision-quality meter entirely —
> **the one instrument that answers Phase A's central rung-3 question.** A single-pass A0 would have
> shipped, read as thorough, and left the audit's own measuring device undiscovered. The convergence rule
> is not ceremony; it found the thing the audit was for.
>
> **A0's own honesty clause.** This report is itself an instrument. Its verdicts carry the source and the
> timestamp of the reading, and any verdict older than the claim that rests on it must be **re-measured at
> claim time**, not quoted from here.

---

## ⚠️ SCOPE — WHICH MACHINE EACH VERDICT WAS MEASURED ON

**Added after a systematic self-check, because #6 was not the only entry missing this.** Finding #15 of
this report establishes that the two machines are **not the same agent** (90 vs 93 guards, different
builds, different provider accounts) and states that *"a verdict does not transfer."* **Most verdicts
below were measured on the Mini alone and were written without saying so.**

| verified on BOTH machines | Mini only — **do not transfer** |
|---|---|
| #13 guard posture (20/90 vs 20/93) | #1 conformance · #2 cartographer · #3/#4 attention · #5 fired column |
| #15 cross-machine parity | #7 claude fallback · #11 quota gauge · #12 codex usage · #14 commitments |
| #16 machine-coherence guard | #18 grounding check · #19 decision-quality · #20 parallel-work |
| #17 memory metric (raw vs corrected, both) | #21 write-admission · #22 self-unblock · #23 peer health |
| #6 provider — **measured both, and they DIFFER** | #24 benchmark-divergence · #25 tokens · #26 passport · #27 capability registry · #28 alignment |
| #9/#10 laptop settings (laptop) | |

**How I found it:** I corrected #6's scope after measuring the laptop, then asked whether #6 was special.
It was not — **it was the one where the difference happened to be visible.** The rest are unverified on
the laptop, which is a different statement from "the same there."

**Consequence for Level 2:** any node citing an un-transferred verdict must re-measure on the machine it
cares about. **This does not weaken the Mini findings** — the dead backstop, the memory metric, the
ungraded decision meter and the empty indexes are all real where measured. It bounds where they are known
to be true.

---

## VERDICT TABLE

| # | Instrument | exists | wired | effective | one-line reason |
|---|---|---|---|---|---|
| 1 | Conformance-coverage audit | ✅ | ✅ | ⚠️→ | **REPOINTED 05:35Z — now `trustworthy: true`, `verified`.** Basis is still ref-existence = rung 1 |
| 2 | Cartographer doc-tree | ✅ | ✅ | ❌ | 2,120 nodes, **0 authored**; reports green because it is empty |
| 3 | Attention queue — WRITE | ✅ | ✅ | ✅ | 789→790 with id lookup control |
| 4 | Attention queue — READ | ✅ | ✅ | ⚠️ | **No pagination at all** — `limit`/`count`/`take`/`pageSize` all silently ignored |
| 5 | Feature metrics — `fired` column | ✅ | ✅ | ✅ | **Founding case CORRECTED** — it does record fires |
| 6 | LLM primary (codex) **— MINI ONLY** | ✅ | ✅ | ❌ | Refresh token **revoked**; 790 consecutive failures/hr. **The laptop runs a DIFFERENT account and it works.** |
| 7 | LLM fallback (swap → Claude) | ✅ | ❌ | ❌ | **32 attempts, 0 successes, 26h — structurally impossible** |
| 8 | Session gauges | ✅ | ✅ | ✅ | Cross-machine baseline reproduced twice |
| 9 | Idle-session cleanup (laptop) | ✅ | ✅ | ⚠️ | Live and ticking, but **never had eligible work** — unproven, not dormant |
| 10 | Test-run limiter (laptop) | ✅ | ✅ | ✅ | Was watch-only; **armed this run**, flip verified live |
| 11 | Quota gauge | ✅ | ✅ | ✅ | Carries `measuredAt` — honest about its own currency |
| 12 | `/codex/usage` **— MINI** | ✅ | ❌ | ❌ | "no rollout with rate-limit data" — downstream of #6 |
| 13 | Guard-posture surface | ✅ | ✅ | ✅ | Honest + self-classifying — **and it scores the guard set at 20/90** |
| 14 | Commitment registry | ✅ | ✅ | ❌ | 283/349 unclassifiable; **proven unrecoverable**, not merely unrecorded |
| 15 | Cross-machine parity | ✅ | ✅ | ❌ | Machines enumerate 90 vs 93 guards; laptop on an older build |
| 16 | Machine-coherence guard | ✅ | ✅ | ✅ | **Caught the #15 divergence unprompted, live, not dry-run** |
| 17 | Host memory metric (spawn gate) | ✅ | ✅ | ❌ | **Permanently `critical` by construction — 20/27 jobs dead, 421 consecutive failures** |
| 18 | Outbound grounding check | ✅ | ✅ | ✅ | **Caught 2 real errors of mine tonight** — but by literal regex, with a measured false positive |
| 19 | **LLM decision-quality meter** | ✅ | ✅ | ❌ | **750 decisions recorded, 0 ever graded** — and it is the instrument rung 3 would rest on |
| 20 | Parallel-work index | ✅ | ✅ | ⚠️ | 40 of 87 topics carry a real focus — half-populated, not empty |
| 21 | Write-admission layer | ✅ | ✅ | ❌ | `dry-run`, `inventoryComplete: false` — and reports **107 starved event-loop windows / 24h** |
| 22 | Self-Unblock checklist | ❌ | ❌ | ❌ | **Not initialized** — the constitutional standard's mechanical arm is absent here |
| 23 | Threadline peer health | ✅ | ✅ | ✅ | Honest and load-bearing: **135 messages pending to Codey, last ack 2 days ago** |
| 24 | Benchmark-divergence detector | ✅ | ✅ | ⚠️ | Runs, but its one finding is `insufficient-evidence` — starved by #19 |
| 25 | Token ledger + feature metrics | ✅ | ✅ | ✅ | Reconciled: they measure different populations, both correct, **full attribution (0% unlabeled)** |
| 26 | **Agent passport (identity)** | ✅ | ✅ | ❌ | **Reports my fingerprint as `unresolved` while Threadline resolves it** — two surfaces, one identity, disagreeing |
| 27 | Capability registry | ✅ | ✅ | ❌ | `scanState: never-observed`, 0 capabilities — the **fourth** empty index |
| 28 | Intent alignment + decision journal | ✅ | ✅ | ⚠️ | Genuinely assessable (n=16, grade C) but the journal is **2 days stale** |

**Score: 10 of 28 instruments effective** (pass 1: 17 · pass 2: +7 · pass 3: +1 · pass 4: +3). Four of the charter's named instruments (conformance,
cartographer, session gauges, quota gauges) → **two effective, two not.**

**And the number those instruments produce:** of 90 guards, **20 are `on-confirmed`** — 22%. Under the
binding rule that only `effective` counts, that is Phase A's baseline (see #13).

---

## THE HEADLINE: A FAILURE AND A FAILED BACKSTOP (#6 + #7)

These are one story and it is the most consequential thing in this audit.

**#6 — the primary died six hours ago.** Sixty-three internal components are deliberately routed off
Claude onto a second provider. Success counts over widening windows:

| window | successes | errors |
|---|---|---|
| 1h | **0** | 527 |
| 3h | **0** | 1,219 |
| 6h | 6 | 1,271 |
| 12h | 200 | 1,351 |
| 24h | 489 | 1,493 |

It worked all day and died inside the 3–6h band. The stored login's expiry stamp is **6.0 hours** before
the reading, and a live call is refused with *"your refresh token was revoked — sign in again."* **Two
independent readings land on the same moment.** The account is the operator's personal one.

### ⚠️ SCOPE CORRECTION — this verdict is MINI-ONLY, and I applied my own rule to myself to find it

I originally wrote #6 as a fleet-wide verdict and told the operator *"same credential explains both
agents."* **I had only measured this machine.** Finding #15 of this very report says *"every Level 2 node
must state which machine it measured — a verdict does not transfer."* **My own #6 did not.**

Measured on the laptop:

| | Mini | Laptop |
|---|---|---|
| account | `headley.justin@gmail.com` (`a0faa9de…`) | **`justin@sagemindai.io` (`f5579317…`)** |
| last_refresh | 2026-08-03T20:37:37Z | 2026-08-04T00:00:34Z |
| live call | **401 — refresh token revoked** | **✅ `turn.completed`, 14,884 in / 5 out** |

**Two different ChatGPT Pro accounts.** Both id_tokens had expired; **the laptop's silently renewed and
the Mini's was refused.** That renewal capability is the entire fault, and it is one account on one
machine — not a fleet credential.

**Corroborating signal I had already measured and misread:** the laptop's worst component is **72%**
error, against **100%** on five Mini components. A working provider with intermittent failures does not
look like a dead one. **The numbers said so and I read them as one story because I had already concluded
it was one credential.**

⚠️ **Correction to my own earlier claim tonight:** I first reported this as "every call is refused, one
dead credential." That was too strong — it was derived from a single live call, with no timeline. Asking
*when* rather than *whether* produced the real answer.

**#7 — and the thing behind it was already dead.** A failure-swap onto Claude is configured. It fired
**32 times in 26 hours and succeeded 0 times.** Every one a timeout.

The mechanism: each swap attempt is budgeted **5 seconds** (the unset default), while this agent is
configured to force Claude work through **full interactive sessions**, which cannot answer in 5 seconds.
Each setting is defensible alone; together they make the backstop **structurally incapable of ever
firing**.

> **CONTROL:** searched the same record for any successful Claude swap → none. The same search returns
> all 32 failures, so zero means zero, not a blind query.

**Why this is the finding and not the outage:** a safety layer with a documented fallback *reads as
protected*. Nobody exercises a fallback that is never called. The day it is called is the day you find
out. Same shape as #2 below, and as the tripwire that watches transitions and is blind to standing state.

---

## #5 — A FOUNDING CASE, CORRECTED

The inheritance record carries as founding fact: *"the `fired` column does not record fires for most
model-driven features — so 'does it fire?' cannot be an acceptance test."*

**That is wrong, and correcting it changes what Phase A should do.**

Two **model-backed** features with real token spend record fires correctly: `MessageSentinel` (7 fires,
268k tokens) and `CommitmentSentinel` (1 fire, 85k tokens). Deterministic features record fires too
(`rope-health` 37, `rope-recovery-probe` 33, `scope-accretion` 2).

The others show `fired: 0` because they **error before reaching a decision** — every feature with a
non-zero error count has `fired: 0` AND `noop: 0`, because an errored call is never classified.

**The instrument was fine. The thing it was measuring was dead.** Acting on the original founding case
would have sent someone to repair a working column.

The narrower true residue: when the model errors and the **deterministic floor** makes the catch, that
catch is booked as an `error`, not a `fire` — so a floor catch is invisible in the metrics. That is real,
and much smaller than what was written down.

---

## #1 — THE BEST INSTRUMENT IN THE SET, BECAUSE IT INDICTS ITSELF

The conformance audit returns real data (82 standards parsed, 6 families, canary OK, source tree
analyzable and freshness-verified). It reports 59/82 "enforced" — and then tells you not to read that
the obvious way:

- `assessmentConfidence: "unverified"`, `assessmentTrustworthy: **false**`
- reason: the packed constitution **no longer matches the authored registry in this tree**
- `enforcementBasis: "named-ref-existence"` → *"a classification means a ref of that shape RESOLVES, NOT
  that the guard runs, asserts, or is in CI"*
- `convergedMeans:` *"stable on unchanged inputs; NOT that standards are healthy"*

**So "59 of 82 enforced" is a rung-1 count wearing rung-3's name — and the instrument is the one saying
so.** This is the pattern the whole plan wants: an instrument that publishes its own limits. It is not
`effective` for the question "is this standard enforced?", and it is honest about exactly that.

**16 standards have no structural guard named at all.** Ranked by area:
`The Substrate` 8 · `Building` 3 · `Interaction` 3 · `Shipping` 2.

### ✅ RESOLVED 05:35Z — repointed under sanction, flag flipped, substance unchanged

Sanctioned fix 1. Binding moved to a checkout matching the packed asset byte-for-byte.
`assessmentTrustworthy` **false → true**, `assessmentConfidence` `unverified` → **`verified`**,
`coverageState` → `package-stamped`. **82 standards and `enforcedRatio` 0.7195 unchanged** — proving it
was a pointer problem, not content.

⚠️ **Still rung 1.** `enforcementBasis` remains `named-ref-existence`. The instrument is now *trustworthy
about the question it asks*; the question is still "does a reference resolve?"

### ⭐ THE ORIGINAL MEASUREMENT — the "stale registry" was a stale POINTER, not a stale asset

The audit's `assessmentTrustworthy: false` invites the reading *"the constitution asset is out of date."*
**Measured, that is wrong, and the direction matters:**

| | bytes | date | sha256 |
|---|---|---|---|
| packed asset (running dist) | 252,764 | 2026-08-03 19:25 | `5413a0c6…` |
| authored in **configured** tree (`convergence-tier1`) | 247,988 | **2026-07-25** | `b2663eb6…` |
| authored in a **current** checkout (`fix-lease-poll-intent-republish`) | 252,764 | 2026-08-03 18:13 | **`5413a0c6…` — identical to packed** |

**The packed asset is current.** The audit is simply pointed at a July checkout. Total drift: **one
heading** (*User-Facing Fixes Ship Live*), present in the current registry, absent from the old tree.

**So the untrustworthy verdict is a configuration fact, not a content fact** — and the fix is to repoint
the comparison tree, not to regenerate anything. This upgrades #1 from "not usable" to **"usable once
repointed"**, which is a materially different instruction for Level 2.

---

## #2 — GREEN BECAUSE IT IS EMPTY

2,120 nodes · **0 authored** · `freshRatio: 0` · 2,120 never-authored past grace · authoring sweep
**disabled**.

Its health object shows `staleCount: 0`, `snapshotStale: false`, `lastDetectStatus: "ok"` — **three green
fields**. Nothing is stale because nothing was ever written. Any verdict resting on this map today rests
on nothing.

---

## #9 — THE UN-FALSIFIABLE NEGATIVE, COMMITTED IN MY OWN NOTES

The setup list said idle-session cleanup was **dormant on the laptop** — "never once decided to close
anything by itself in a full month."

Measured: **enabled, not dry-run, not auto-disabled, ticking, actively evaluating** (1 session → verdict
`keep`, `keptBy: spawn-grace`). Config is **byte-identical** to the Mini's.

It never closed anything because **that machine had almost nothing to close.** A record of never acting,
produced by something that never had the chance to act — the exact error class this whole line of work
exists to catch, committed in my own setup list and carried into an operator decision.

**Consequence:** of the two settings the operator approved, only one was real.

---

## #10 — THE ONE REAL SETTING, ARMED

Genuinely divergent, and not via config: posture comes from a host tuning file the Mini has and the
laptop lacked. Laptop `dry-run` → Mini `enforcing`.

**Armed on the laptop's own evidence, not the Mini's** — a full month (7,295 events, 2,479 acquires),
205 would-blocks and 1,652 would-clamps concentrated on heavy days, **zero capacity timeouts and zero
saturation**. The Mini had armed on 16 acquire-release pairs; the laptop's soak is ~150× larger and the
same clean shape.

**Verified it took effect** (enabled is not running): posture re-read live → `enforcing`. Rollback:
delete the file.

---

## #11 — A PASS WORTH NAMING

The quota gauge carries `measuredAt` per reading. Five accounts refreshed within seconds of the read;
one (`adriana`) is **11.3 hours stale** — and the surface *says so*. A consumer reading only the
percentage would be misled; the instrument itself is honest. **Rung 3 pass, with a usage caveat**, not
an instrument defect. (I initially misread this gauge as blank — my parse used the wrong field path.
Recorded because the mistake was mine, not the instrument's.)

**Pool state at the reading** — this prices any decision to move work onto Claude:

| account | 5h % | 7d % | note |
|---|---|---|---|
| adriana | 0 | **100** | weekly exhausted; reading 11.3h old |
| gearfinity3d | 0 | **100** | weekly exhausted |
| sagemind-justin | 0 | 80 | |
| sagemind-dawn | 9 | 66 | |
| justin-gmail | **84** | 33 | hot on 5h |
| sagemind-adriana | **100** | 27 | 5h exhausted |

**Two of six weekly-exhausted; two more at 66–80%.** And the pool holds **zero** accounts for the
provider that actually runs the internal checks — so that quota is invisible and unmanageable.

---

## #13 — THE GUARD SET, SCORED BY THE PLAN'S OWN RULE (the headline number for Phase A)

The guard-posture surface **already implements a three-rung-shaped classification**. Applying the
binding decision *"only `effective` counts"* directly to its 90 guards:

| classification | count | reads as |
|---|---|---|
| `on-confirmed` | **20** | **rung 3 — effective** |
| `on-unverified` | 40 | rung 2 — wired, unproven |
| `on-dry-run` | 11 | watching, not acting |
| `off` | 18 | 7 deviant + 11 dark-by-default |
| `on-blind` | 1 | on, cannot see |

> **20 of 90 — 22% — of this agent's guards currently reach `effective`.**
> Under the ratified rule, **78% do not count as aligned.**

**Why 40 are unverified:** `runtimeReason: "not-instrumented"` on **62 of 90**. Only **26/90** are
runtime-enriched. There is no probe that confirms most guards actually *do* anything — which is precisely
the gap between rung 2 and rung 3, present as a measured fact rather than a thesis.

**`offDeviant: 7`** — confirms last window's "seven guards read diverged-from-default", now with a
sharper classification (7 deviant vs 11 legitimately dark-by-default). The earlier finding conflated
those two.

**9 load-bearing guards are not `on-confirmed`**, 3 flagged as outright load-bearing gaps — including
mesh reachability recovery, durable operator inbound message delivery, and topic reachability when an
owner machine dies.

**This is the number Phase A turns on.** It is not an estimate; it is the product's own posture surface
scored by the plan's own rule.

---

## #14 — COMMITMENT REGISTRY: FOUNDING CASE CONFIRMED, AND NOW PROVEN UNRECOVERABLE

Re-measured tonight: **1,179 total · 349 pending · 348 owned by agent · 332 with nothing blocking them.**
Of the 349 pending, **283 say `source: agent`** — which covers *both* a deliberate promise and an
automated capture — against 66 provably automatic (46 sentinel + 20 detection).

Last window recorded that the count is uninterpretable. **I tested whether it could be recovered**, since
"unmeasurable" is a strong claim:

| candidate discriminator | known-automatic (66) | ambiguous (283) | verdict |
|---|---|---|---|
| `externalKey` present | 0 / 66 | 1 / 283 | ❌ absent in both |
| `userRequest` populated | 66 / 66 | 283 / 283 | ❌ present in both |
| `agentResponse` populated | 66 / 66 | 283 / 283 | ❌ present in both |
| `beaconEnabled` set | 2 / 66 | 2 / 283 | ❌ absent in both |

**The control could have succeeded** — had `externalKey` marked the automatic captures, it was the
discriminator. It does not. So the finding upgrades from *"not recorded"* to **"not recoverable from the
record"**: no structural field separates a promise I made from an intention something wrote down for me.

Residual signal: the two populations *read* differently in free text (auto-captures quote a real user
utterance; the ambiguous ones read self-authored). **A heuristic could guess. The record cannot answer.**

---

## #15 — CROSS-MACHINE PARITY: THE TWO MACHINES ARE NOT THE SAME AGENT

Phase A verdicts will rest on both machines, so A0 was re-run on the laptop.

| | Mini | Laptop |
|---|---|---|
| guards enumerated | **90** | **93** |
| `on-confirmed` | 20 | 20 |
| `on-unverified` | 40 | 47 |
| `on-dry-run` | 11 | 10 |
| `off` (deviant / dark-default) | 18 (7 / 11) | 14 (6 / 8) |
| `missing` | 0 | **2** |
| runtime-enriched | 26 / 90 | 26 / 93 |
| `llmReliability` | failing | failing |
| `version` on `/health` | `1.3.1123` | **field absent** |

**Three findings:**

1. **The machines enumerate different guard sets** (90 vs 93) and the laptop's `/health` does not carry a
   `version` field at all — it is on an **older build**. A verdict measured on one machine does **not**
   transfer to the other. Every Level 2 node must state which machine it measured.

2. **Two guards read `missing` on the laptop** — `scheduler.enabled` and `monitoring.greenPrAutoMerge.enabled`.

   ⚠️ **CORRECTED — I first wrote this up as a blind spot and it is not one.** My draft claim was that the
   laptop's scheduler "is not running at all" (33 job manifests on disk, `scheduler: {enabled: true}` in
   config, `{"jobs":[],"scheduler":null}` at runtime). **The grounding gate refused that message** on the
   grounds that I was calling an absence from a single source.

   Four further sources settled it: the laptop's own log says, repeatedly,
   **`Scheduler skipped (standby mode)`**. That is *correct behaviour* — exactly one machine runs the
   scheduler and the laptop is deliberately not it. The guard reading `missing` follows from the scheduler
   not being constructed, which is right on a standby machine.

   **Verdict: withdrawn.** No defect here. What remains true is narrower and unalarming: a standby
   machine's guard inventory legitimately differs from the active machine's, so **guard counts are not
   comparable across roles** — which is still a constraint on Level 2 (a node must state the machine AND
   its role).

   *Recorded at length because this was the third near-miss of the run and the only one caught by
   something other than me.*

3. **`llmReliability: failing` on both.** The primary/backstop failure is not machine-local.

---

## #16 — AN INSTRUMENT THAT PASSES RUNG 3, AND IT MATTERS THAT ONE DOES

The machine-coherence guard is **`enabled`, NOT dry-run**, 155 ticks, **0 errors** — and it independently
**detected the exact divergence above** while I was measuring it by hand:

- `skewsConfirmed: 1`, `confirmedRows: 1`, `episodesOpened: 1`, `itemsRaised: 1`
- raised **calm and silent** (`calmRaises: 1`, `calmRaisesSilent: 1`) — correct behaviour for a routine
  version skew, which should be visible without buzzing anyone
- one prior episode already closed as `restored` — so it has completed a full detect→resolve cycle

**This is the strongest rung-3 evidence in the audit**, and it is nearly a live rung-3 test: a real
divergence existed, the guard caught it unprompted, classified it correctly, and I confirmed the
divergence independently by hand. It is not the contract's injected-violation test, but it is the closest
thing measured tonight — and it proves the bar is **reachable**, not theoretical.

**Worth stating plainly:** the 78%-not-effective number is not an indictment of the design. One guard
here does exactly what the contract asks. The gap is that **62 of 90 have no runtime instrumentation at
all**, so they cannot even be asked.

---

## #4 — REFINED ON RE-TEST (my first write-up was too vague to act on)

First pass: *"`limit` parameter silently ignored"* — derived from one probe (`?limit=1` → 789 items).
Given this run's error pattern, I re-tested rather than leaving it.

| query | items returned |
|---|---|
| `?limit=2` | 795 |
| `?count=2` | 795 |
| `?take=2` | 795 |
| `?pageSize=2` | 795 |
| **`?limit=2&status=OPEN`** | **86** |
| `?scope=pool` | 442 (+ `pool` block) |

**CONTROL:** `status=OPEN` works and `scope=pool` works — so the query string **is** parsed. 795 across
every pagination spelling is therefore a real absence, not a wrong parameter name.

**Corrected verdict:** the read surface supports **filtering** but has **no pagination whatsoever**. A
bound is *silently ignored* rather than rejected — so a caller that asks for 2 receives 795 and has no way
to know its bound was dropped. That is the actionable form; "limit is ignored" was not.

(`scope=pool` returning fewer items than local is expected — pool-wide events coalesce to one row by
design. Checked before flagging it.)

---

## #17 — THE MEMORY METRIC: A LIVE OUTAGE, AND THE MISSED SIBLING FOUND

**The most consequential finding in this audit, and it was found by following a job failure — not by
looking for it.**

**20 of 27 enabled jobs on the Mini are failing**, all with the identical error
`Reroute refused (force-mode): host memory pressure is critical`. `health-check` and
`commitment-detection` are each at **421 consecutive failures**, going back at least to 2026-08-02.
The refusal is firing live, every 5 minutes, as of 03:45Z.

### The metric is wrong by construction on this platform

```js
currentMemoryPressure() {
  const freeMem = os.freemem();                                    // raw free PAGES only
  const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
  if (usedPercent >= 90) return 'critical';
}
```

Measured live on this machine: `totalmem 17.2 GB`, `os.freemem() 0.46 GB` → **2.7% free → 97.3% used →
`critical`, permanently.** macOS deliberately holds spare RAM as cache, so this figure is near-zero on a
*healthy* machine essentially always.

**Three readings of the same machine, at the same moment, disagree:**

| source | reading | verdict |
|---|---|---|
| `SessionManager.currentMemoryPressure()` | 2.7% free | **critical** |
| `SessionReaper` (`freePct`) | 16.3% free | **normal** |
| macOS `memory_pressure` | 38% free | healthy |

Under `subscriptionPath.mode: "force"` a critical verdict **throws** (force has no headless fallback), so
every job spawn is refused.

### The sibling proof — the correction is already in the same package

`monitoring/hostMemoryPressure.js` exports **`hostFreeMemPct()`** (free + inactive + purgeable via
`vm_stat`; `MemAvailable` on Linux). `HostPressureSampler` uses it, and its **shipped comment names this
exact bug**:

> *"freePct is the CORRECTED available-memory percentage … **NOT `os.freemem()`, which on macOS reports
> only raw free pages (~0.1%) and falsely registered as critical**, over-reaping sessions + permanently
> blocking revival." — Spec: `macos-memory-pressure-metric`*

**The reaper was fixed. `SessionManager.currentMemoryPressure()` was not.** The comment even lists the
symptom class; this outage adds a third symptom it does not list — **permanently blocking job spawns.**

⚠️ **This is the sibling predicted in window 5.** That window recorded: *"the memory reading that started
this outage — a correct fix in late June repaired the component that was misbehaving and missed the one
that later killed your scheduled jobs."* **It was right, and here is the count: 421.** The prediction was
made from the shape of the repair, not from evidence; the evidence now exists.

### Not fixed, deliberately

Charter is measurement, not repair. A code fix belongs in the dev pipeline with a spec (one already
exists) and tests. Two paths offered to the operator: the one-line code fix, or the reversible setting
change (`force` → `auto`, which degrades instead of throwing) — the latter unblocks the jobs in minutes
**but moves them onto a different allowance**, so it was presented as a cost choice, not a free one.

**Close criterion:** an enabled job observed running to success on this machine. *Changing the setting is
not closing it.*

### It reaches BOTH machines — the clearest form of the fault

Re-ran the same computation on the laptop: **137.4 GB total, 21.14 GB genuinely free** →
`os.freemem()` arithmetic yields **85% used → tier `high`**. The reroute gate refuses on
`high` **or** `critical`, so a reroute spawn there would be refused too.

The corrected reading on that same machine, same second: **58% free, tier `normal`.**

> **A machine with 137 GB of RAM and a fifth of it free is classified as under memory pressure.**

**Consequence for the plan:** the ratified placement policy puts worker lanes on the laptop, and that was
being treated as the escape from the Mini's saturation. **It is not a clean escape** — the same gate,
reading the same wrong number, would refuse spawns there as well. This must be fixed rather than routed
around.

---

## #18 — THE CHECK THAT KEPT CATCHING ME, MEASURED HONESTLY

The pre-message grounding check blocked **three** of my outgoing messages tonight. Calibration, since I
am the sample:

| # | what it blocked | verdict |
|---|---|---|
| 1 | *"the laptop's scheduler is not running at all"* | ✅ **TRUE POSITIVE** — withdrawn; the scheduler is correctly skipped in standby |
| 2 | *"there is no launchd job for Codey's tunnel"* | ✅ **TRUE POSITIVE** — wrong on two counts, incl. reasoning about a list I had truncated with `head -4` |
| 3 | *"There is no amount of paying attention that catches this"* | ❌ **FALSE POSITIVE** — rhetorical clause |
| 4 | *"there is no tunnel process for him running now"* | ❌ **FALSE POSITIVE** — the absence was already evidenced from 3 sources |
| 5 | *"there are no exceptions in either direction"* | ❌ **FALSE POSITIVE** — describing a *perfect correlation*, the opposite of an absence |

| 6 | *"there is no tunnel process for him running now"* (2nd) | ❌ **FALSE POSITIVE** |
| 7 | *"there is no economy of scale to find in the tree"* | ❌ **FALSE POSITIVE** — describing a measured *structural fact* |
| 8 | *"there is no canonical one to copy from"* | ❌ **FALSE POSITIVE** — a conclusion FROM data, not an absence of data |

| 9 | *"there is no such record anywhere"* / *"no such moment is recorded"* | ❌ **FALSE POSITIVE** — describing three deliberate `unmeasured` verdicts |

⚠️ **CORRECTED THREE TIMES. "2 true / 1 false" → "2 true / 3 false" (04:47Z) → "2 true / 5 false"
(06:20Z) → now 2 true / 7 false (07:30Z). Precision 25%.** The ratio has moved every single time I have
looked. A calibration taken once and left alone is exactly the stale-verdict failure this audit is about
— committed on the instrument I was grading, then committed *again* on the correction. **This entry now
carries a standing instruction to itself: re-measure before quoting.**

**All five false positives are the same literal substring** (`there is/are no`), in sentences that assert
a *finding* rather than an absence — including one describing a perfect correlation and one describing a
measured structural fact about the constitution. **The check cannot distinguish "I found nothing" from
"I found that nothing exists," and those are opposite epistemic states.**

**Both true positives were about to reach the operator as confident, quotable, false findings** — so on
*consequence* this is still the highest-yield instrument measured tonight, the only one that caught *me*.
On *precision* it is 40%.

**But its mechanism is a literal regex.** Read from source: it matches
`there (is|are) no([^a-zA-Z]|$)`, `nothing (to report|happened|was found)`, `could(n't| not) find (any|the)`
and similar. It does not read meaning — #3 tripped purely on the substring *"There is no "*.

**Verdict: `effective` — with a named limitation, and a precision cost that is now measured.** It works,
it is not dry-run, and it demonstrably bites. But:

⚠️ **It is a deterministic string-matcher sitting where the constitution names a standard —
*"Intelligent Prompts — An LLM Gate Must Not String-Match."*** So the highest-yield guard measured tonight
is, by that standard's own terms, built the way the standard says not to build it. **A paraphrase evades
it and a rhetorical flourish trips it.**

**All three false positives tripped on the same literal substring** (`there is/are no`), in sentences that
claimed no absence at all — one of them describing a *perfect correlation*. That is not a tuning problem;
it is what string-matching does. That is not an argument for removing it — it caught two real errors and
cost three rewrites. It is a
**Level 2 case worth auditing on its merits**: a guard whose *effectiveness is measured* and whose
*mechanism is non-conforming*. Which of those two facts governs is a question for the architect, and it
is exactly the kind of tension a three-rung verdict is supposed to surface rather than hide.

---

## #19 — ⭐ THE RE-SWEEP'S HEADLINE: THE INSTRUMENT RUNG 3 DEPENDS ON IS EMPTY, AND THE MEMORY BUG IS WHY

**A0 pass 1 missed this entirely.** It exists only because the convergence standard required a second
sweep over instruments I had not checked. **This is the strongest argument in the run for the
audit-to-convergence rule** — the single most load-bearing instrument was not in the first pass.

**The measurement:** the LLM decision-quality meter is `enabled: true`, `dryRun: false`, and carries
**39 decision points, 16 of them active, 750 decisions recorded — and 0 outcomes graded. Zero.**

That meter is what answers *"is this gate actually right?"* — i.e. **precisely the rung-3 question for
every LLM-driven guard.** It has never produced a single graded verdict.

### The causal chain, measured end to end

1. `llm-decision-grading` is the job that grades those decisions. It is **`enabled: true`**.
2. It has **36 consecutive failures**, last run **04:00:00Z**, `lastResult: failure`.
3. Its `lastError` is verbatim: **`Reroute refused (force-mode): host memory pressure is critical`** —
   **the same defect as #17.**
4. Therefore: **the memory metric bug → the grading job cannot run → 750 decisions stay ungraded → the
   instrument that measures guard effectiveness has no data.**

### Why this changes the priority of the #17 fix

I put the memory fix to the operator as an operations problem: *20 dead jobs, restore service.* **That
framing understated it.**

> **#17 is on Phase A's critical path.** Rung 3 for every LLM-driven guard is unmeasurable until the
> grading job runs, and the grading job cannot run until the memory metric is corrected.

So the decision is not "fix some dead jobs when convenient." It is: **Phase A cannot complete its central
measurement while that bug stands.** Same bug, same one-line fix, materially higher priority — and I only
learned it by sweeping a second time.

### Honest limits

- `runningCount: 0` on the parallel-work index while a session is demonstrably running is unexplained; I
  did not chase it and am not claiming it is a defect.
- I misread the per-point `insufficient-evidence` flag on the first print (hyphenated vs camelCase key).
  **The load-bearing number does not depend on it:** `outcomesKnown: 0` across every point, 750 decisions.

---

## ROUND 2 — THE REST OF THE RE-SWEEP

**#22 — the Self-Unblock checklist is not initialized.** `monitoring.blockerLedger.selfUnblockChecklist`
is false, so the route 503s. That is the **mechanical arm of the constitutional standard "Self-Unblock
Before Escalating"** — the thing that is supposed to refuse to settle a blocker as real until a verified
exhaustion run is on record.

⚠️ **This lands on me directly.** Tonight I told the operator that the expired login is a rung-1 ask
(a sign-in only he can do) because I hold no credential for his personal account. **That reasoning was
sound but it was reasoning — there is no persisted exhaustion run behind it, because the mechanism that
would produce one is switched off.** So my escalation was *argued*, not *proven*. Recorded as a limit on
my own claim, not as a defect in someone else's code.

**#23 — the peer-health instrument is honest, and it quantifies the Codey problem.** `staleCount: 5`, and
the `instar-codey` row shows **135 messages pending with the last acknowledgement dated 2026-08-02.**

That is **independent corroboration, with a number, of the operator's correction** — the agent-to-agent
channel *stores* to Codey and does not *wake* him. 135 messages queued over two days is what
"delivered but never read" looks like when someone finally measures it. **This instrument was working and
saying so the whole time; nobody had asked it.**

**#21 — write-admission is dry-run with an incomplete inventory**, and carries a signal worth flagging
even though it is not my charter: **107 starved event-loop windows in 24h** (p50 33ms, p99 51ms). Not
chased; recorded.

**#24 — the benchmark-divergence detector runs and cannot conclude.** Its single finding is
`insufficient-evidence`, `missingModelShare: 0.29`. **Downstream of #19** — it compares real grade-rates
against benchmark predictions, and there are no grades. A second instrument dark for the same root cause.

---

## ROUND 3 — AND A REFINEMENT TO A NUMBER I GAVE THE OPERATOR

Round 3 swept 14 further surfaces. **Most are healthy or documented-dark** (`green-pr-automerge` and
`release-readiness` 503 on repo-gating; `pool/queue` and `duplicate-reconciler` dry-run as shipped;
`conversations/health` empty, which is *correct* on a Telegram-only agent since Telegram topics pass
through and are never minted).

**One thing did not add up, and it was a number I had already used to price a decision for the operator.**

`/tokens/summary` reports **134,060,865 total tokens** while showing `totalInput: 28,341`. Those cannot
both describe the same thing. Resolved by reading the shape:

| field | value |
|---|---|
| totalInput | 28,341 |
| totalOutput | 532,016 |
| **totalCacheRead** | **113,647,575** |
| totalCacheCreate | 19,852,933 |
| **sum** | **134,060,865 ✓** |

So `/tokens/summary` measures **my own interactive transcripts, dominated by cache reads**, while
`/metrics/features` measures **internal component calls**. Different populations, no conflict, both
correct. ✅ **The 13.4M figure I quoted the operator came from the right instrument.**

⚠️ **But it needs one refinement, and it moves the decision slightly.** Of that 13.2M `tokensIn`,
**4,996,992 is cache reads.** Fresh input is therefore **≈8.2M/day, not 13.4M.** I priced the
"move the checks onto Claude" option at the gross figure. **The real cost is about 40% lower than I told
him** — still material against two weekly-exhausted accounts, but I quoted the wrong end of it and should
say so.

**A genuine pass worth naming:** `unlabeledTokenShare: 0`, `unlabeledCallShare: 0` — every LLM call is
attributed to a named component. That is the **Token-Audit Completeness** standard actually holding, and
it is one of the few places tonight where a standard's guard is both present and demonstrably working.

---

## ROUND 4 — THE CONSTITUTION'S RUNTIME SURFACES, AND A SELF-IDENTITY CONTRADICTION

**#26 — the passport and Threadline disagree about who I am.**

| surface | my routing fingerprint |
|---|---|
| `/passport` | **`"unresolved"`**, `allowedCapabilities: []` |
| `/threadline/health` | **`63b1dbb21646e2f5f860441f6c6443ad`** |

Both on this machine, seconds apart. The documented contract says these are *"sourced from my canonical
`identity.json`, so they always agree."* **They do not.**

This matters more than a cosmetic mismatch: **the passport is the artifact I would hand a peer to prove
what I am allowed and forbidden to do.** A passport that cannot resolve its own holder's identity, and
carries an empty capability list, cannot perform that function. Meanwhile `mutualVerifiedCount: 0` — no
peer is mutually verified, so a credential share to any peer would be refused fail-closed. (That is the
gate working correctly; noted so the two are not confused.)

**#27 — a fourth empty index.** `scanState: "never-observed"`, zero capabilities. The pattern across A0 is
now unmistakable and worth stating as a class rather than four separate findings:

> **Four instruments — the doc map, the decision-quality meter, the capability registry, and (half) the
> parallel-work index — are enabled, wired, enumerating nothing.** None of them reports a problem. Three
> of the four report fields that read *green* while empty. **An index that has never been populated is
> indistinguishable, from its own health surface, from an index with nothing to report.**

That is the single most repeated structural defect in this audit, and it is the same shape as tonight's
dead backstop: **absence presenting as health.**

**#28 — alignment is genuinely measurable, and the journal is stale.** `assessable: true`, `sampleSize:
16`, grade C (58), `principleConsistency: 0`, `journalHealth: 30`. The decision journal holds 46 entries,
41 principled / 5 not — but its **latest entry is 2026-08-02**, two days old. So the score is a real
measurement over a real sample, computed on a record that has not been written to in two days. **Usable
with its date attached; misleading without.**

---

## ⭐ WHAT "CONFIRMED" ACTUALLY MEANS — and why instrumenting the rest is a trap

Deepening #13, because the Level 2 draft leans on that 20/90 number and the architect will be asked what
it would cost to move it.

**The correlation is perfect and mechanical:**

| | runtime-enriched (26) | not instrumented (64) |
|---|---|---|
| `on-confirmed` | **20** | **0** |
| `on-unverified` | 0 | 40 |
| `on-dry-run` | 3 | 8 |
| `off` / `on-blind` | 3 | 16 |
| process | all `server` | 63 `server`, 1 `lifeline` |

**Every enriched guard carries the same thing: a `lastTickAt` / `tickAgeMs` heartbeat.** Every
non-enriched one carries no runtime block at all (`runtimeReason: not-instrumented` ×62).

> **So `on-confirmed` means exactly one thing: the guard registers a periodic tick the server can
> observe.** It does not mean the guard decides correctly, or bites, or has ever fired.

That sharpens my earlier caveat from "nearer rung 2 than rung 3" to something precise:
**`on-confirmed` is rung 2, evidenced by a heartbeat.**

### ⚠️ THE TRAP, and it is the reason to write this down

Instrumenting the other 64 is a small mechanical change per guard — register a ticker in the server
process. It would move the headline from **20/90 to something near 90/90.**

**And it would add ZERO rung-3 evidence.** A heartbeat proves a guard is *running*, never that a
deliberately introduced violation gets *caught*. The contract's third rung is not what this surface
measures and no amount of instrumenting will make it so.

**A plan that optimises this number would look like dramatic progress and mean nothing** — which is the
same failure this whole phase exists to prevent, one level up: **improving the instrument's coverage
instead of the thing it measures.** Recorded before anyone proposes it, including me.

**What it IS good for:** the 64 have no evidence they run *at all*. Instrumenting them is worth doing on
its own merits — it closes the gap between "configured" and "running". It just must not be reported as
progress toward `effective`.

---

## MY OWN PROBING ERRORS THIS PASS — recorded, because an auditor's misses are audit data

1. **Wrong parameter name** (`topic=` vs `topicId=`) read as a refusal from two instruments. Nearly wrote
   up two working instruments as broken.
2. **Missing intent header** read as a second conformance failure.
3. **Wrong field path** on the quota gauge → reported every account as blank.
4. **`pgrep` matching the shell wrapper** — the exact defect I documented last window, re-committed within
   the hour, caught only because I recognised the output shape.
5. **Flags in a shell variable for SSH** — the precise thing my own memory note warns against.
6. **Failed to attach the compliance token** on the first tone-gate catch, so a correct catch will grade
   `unknown` instead of `right`. Corrected on the second.
7. **Guessed `state` then `posture`** for the guard classification field; the field is `effective`. Both
   guesses returned `None` for all 90 rows — which I could have written up as "the guard surface reports
   nothing."
8. **Read `version` off the laptop's health and got `None`**, then checked the key list rather than
   reporting a blank — which turned a parse error into the real finding (the field is genuinely absent
   there, i.e. an older build).

**Six of eight were caught by a control rather than by care**, and three of them (#1, #3, #7) would each
have produced a confident write-up of a *working* instrument as broken. **That is the argument for
controls over care** — and the reason every ❌ in this report names the control that could have
overturned it.

⚠️ **The pattern across #1, #3, #7 is one thing: I guessed a field or parameter name, got an empty
answer, and read the emptiness as a finding.** That is the session's headline rule — an unfalsifiable
negative — committed four times in one audit *about* unfalsifiable negatives. The fix that actually
worked every time was cheap and mechanical: **print the shape before reading the value.**

---

## WHAT A0 LICENSES

- **Usable now:** attention write, feature metrics, session gauges, quota gauge (read `measuredAt`),
  test-run limiter.
- **Not usable as evidence:** the doc map (empty); "enforced" counts from the conformance audit (rung-1
  basis, self-declared untrustworthy); anything downstream of the model-backed checks until #6/#7 clear.
- **Blocks Level 2:** no per-standard audit node may take a verdict from #1's `enforced` field or from #2
  at all. Nodes must re-derive from source, or declare the standard unmeasurable and say why.


---

# ⚠️ AMENDMENT — 2026-08-04 07:43Z — THE CONVERGENCE CLAIM ABOVE IS TOO STRONG. IT IS NOT WITHDRAWN; IT IS RESCOPED.  ⟨timestamp corrected: originally written as 07:46Z — written ahead of the real clock, three minutes after correcting the identical error⟩

**The header above stands as written and is not edited** (append-only discipline). This amendment narrows
what it may be read to mean.

## What happened
A0 declared convergence at 04:20Z on the stated bar: **two consecutive rounds adding zero new
instruments.** Between 07:26Z and 07:42Z — three hours later, in the same window — **four new defects
surfaced on instruments that were already in this inventory:**

| found | instrument | defect | in A0's scope? |
|---|---|---|---|
| 07:26Z | guard classifier | a guard can be enabled, ticking, and **structurally blind** — a state the classifier had no label for | ✅ yes |
| 07:31Z | guard classifier | **`on-dry-run` is an absorbing label** — it simultaneously carries "deliberately dry-run", "blind", and "never ticked once" | ✅ yes |
| 07:31Z | external-hog sentinel | `samplerDead: false` **is not a measurement** — nothing could ever have set it true, on a guard whose last tick reads 1970 | ✅ yes |
| 07:42Z | `/guards` census | **23 of 27 enabled scheduled jobs have no row in it at all** — the census is blind to the entire job enforcement layer | ✅ yes |

**All four are in-scope instruments. `/guards` is named explicitly in the A0 charter.** So this is not
scope creep finding new territory — it is the *same* territory yielding new facts after I had certified
it stable.

## ⭐ The actual defect, which is in the convergence bar and not in the audit
> **Two echo rounds prove the *probe* is exhausted. They do not prove the *surface* is.**

Rounds 5 and 6 re-ran **the same method** and found nothing new — which is exactly what a saturated method
does, whether or not the surface still holds findings. Every one of the four defects above came from a
**method A0 had not used**: reading the runtime block inside the guards payload rather than the
classification; cross-tabulating the job registry against the guard census; asking the kernel for its own
pressure verdict instead of comparing my derived percentages to each other.

**I measured convergence by item-discovery and then relied on it for verdict-stability.** Those are
different properties and only the first was tested.

## Rescoped claim
- ✅ **A0 converged on enumeration.** The list of 28 instruments is stable; no new instrument has appeared.
- ❌ **A0 did NOT converge on verdicts.** Four verdicts on already-listed instruments changed after the
  convergence declaration, all in the same window, all from new methods.

## Consequence for the convergence bar going forward — proposed, not adopted
A round that repeats the previous round's method is **not evidence of convergence**. An echo round should
count only if it **introduces a probe the prior rounds did not use.** Under that bar A0 has had, at most,
**one** genuine echo round and is **not yet converged.**

This is a change to a constitutional standard's operating definition and therefore **the architect's call,
not mine.** Filed as a finding, carried to the plan tree, not applied.

**Source:** live probes 07:26Z–07:42Z, this machine, instar 1.3.1124. **Re-measure at claim time.**


---

# AMENDMENT 2 — 2026-08-04 07:49Z — `/guards` RUNG-3 VERDICT, FROM A PROBE A0 NEVER RAN  ⟨timestamp corrected: written as 07:52Z — third ahead-of-clock stamp today, in the one file my new helper does not cover⟩

Amendment 1 argued A0 converged on *enumeration* but not on *verdicts*, and that an echo round only
counts if it brings a new probe. **This is that new probe, and its yield is the argument.**

**Probe:** read each guard's **own audit trail** and its **runtime block**, and reconcile both against the
**classification** shipped in the same JSON object. A0's earlier passes read the classification alone.

## Result: three defects, one shared signature, on the instrument Phase A most depends on

| # | guard | classification says | evidence says | 
|---|---|---|---|
| 1 | `scheduler.enabled` | **`on-confirmed`** (highest trust) | 21 of 27 enabled jobs failing ~22h; runtime block has **no failure field** — `jobCount` counts registrations, `pausedJobCount` counts the 15 disabled |
| 2 | `monitoring.sessionReaper.enabled` | **`on-confirmed`** | ticks perfectly and **measures wrong** — calls a kernel-WARN host `normal` |
| 3 | `monitoring.enforcedTermination.enabled` | **`off` / `dark-default`** (the never-alert class) | runtime `enabled:true`, ticked 72s ago, **10,160 audit entries**, 1,690 `would-terminate` |

**Shared signature: a self-report field that could not have shown otherwise.** In cases 1 and 3 the
classification contradicts the runtime block **carried inside the same object**, and nothing reconciles
them. That reconciliation is a small mechanical check and would have caught all three.

## What `on-confirmed` actually asserts
> It ticks, recently, and its enable flag is true.

Not that it measures correctly. Not that it can see its subject. Not that the thing it governs is
healthy. **Those are the three questions "are my guards on?" is asking.**

## Scope defect, same instrument (07:42Z)
89 of 90 rows run in the server process, 1 in the lifeline. **None is job-driven.** 23 of 27 enabled
scheduled jobs — the correction analyzer, decision-grading, benchmark divergence, five overseer reviews,
reflection, maturation, evolution — have **no row at all**, while 21 of 27 sit dead.

## ✅ A clean result, recorded because an audit that only reports faults is biased
**The Guard-Posture Tripwire is healthy.** `logs/guard-posture.jsonl` holds 9 entries over two months,
each a genuine `guard-posture-change` carrying `prevTs` — proving it compared against the prior boot.
No entry at the 07:02Z boot is **correct**: the deploy changed code, not posture. The check could have
shown a missing comparison, an absent `prevTs`, or a boot gap. It showed none. **Verdict: `effective`.**

## Rung-3 verdict on `/guards`
`exists: true` · `wired: true` · **`effective: false` as a trust signal** — accurate as a liveness check,
misleading as the certification it is presented and universally read as. It remains sound for what it
does cover; this is a scope-and-labelling defect, not a correctness defect in the rows themselves.

**⚠️ Consequence for Phase A:** every Level 2 node that planned to source a rung-3 verdict from
`/guards` must treat `on-confirmed` as *liveness only* and obtain effectiveness elsewhere — audit trail,
runtime block, or the governed subject's own state. **This changes the method of the audit that has not
yet run, which is the cheapest possible moment to learn it.**

**Source:** live probes 07:26Z–07:49Z, this machine, instar 1.3.1124. Re-measure at claim time.


## Grounding gate — matcher read from source (2026-08-04 08:07Z)

`.instar/scripts/convergence-check.sh:42` — the SETTLING rule is a single `grep -qiE` over six literal
alternatives, with no model in the path:

```regex
(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)
|there (is|are) no([^a-zA-Z]|$)|could(n.t| not) find (any|the)|appears to be empty
|no (relevant|matching|applicable))
```

**Verdict: `exists: true` · `wired: true` · `effective: FALSE` — evidenced from source, not inferred.**
Calibration **16 blocks · 2 true · 14 false · precision 12%**, falling at every re-measurement
(25% → 22% → 20%). It cannot distinguish a claim's direction from its surface form; all 8 blocks fired on
literal negation strings, including one on a clause describing a system's fallback path.


---

# RE-MEASUREMENT PASS — 2026-08-04 08:1xZ (rule 5, anti-decay)

Triggered by the discovery that the internal LLM layer has collapsed to **0 successes in 2h**. I claimed
at 08:02Z that A0's certified instruments were therefore *"suspect and must be re-measured."*
**Re-measured. That claim was over-stated, and one instrument changes for an unrelated reason.**

## 1. Does the LLM collapse invalidate any of the 10? **NO.**

| # | effective instrument | depends on LLM judgment? |
|---|---|---|
| 3 | Attention queue — WRITE | ❌ deterministic HTTP write |
| 5 | Feature metrics `fired` | ❌ deterministic recording |
| 8 | Session gauges | ❌ deterministic |
| 10 | Test-run limiter | ❌ deterministic semaphore |
| 11 | Quota gauge | ❌ deterministic read (and carries `measuredAt`) |
| 13 | Guard-posture surface | ❌ deterministic classification |
| 16 | Machine-coherence guard | ❌ deterministic advert comparison |
| 18 | Outbound grounding check | ❌ **pure regex — confirmed from source** |
| 23 | Threadline peer health | ❌ deterministic ledger |
| 25 | Token ledger + feature metrics | ❌ deterministic accounting |

**All ten are deterministic. The collapse degrades LLM-*bearing* systems (tone gate, sentinels,
classifiers, the decision-quality meter) — none of which were among the certified ten.**
⭐ **My 08:02Z alarm was wrong in the safe direction, and correcting it matters as much as correcting
the other way.**

## 2. #18 — DOWNGRADED ✅ → ❌ (not LLM-related; a better measurement)

A0 recorded it *"caught 2 real errors of mine tonight — but by literal regex, with a measured false
positive."* **Tonight's evidence is far stronger than that hedge:**
- **The matcher read from source** (`convergence-check.sh:42`): one `grep -qiE`, six literal
  alternatives, no model in the path.
- **Calibration 9 blocks · 2 true · 7 false · precision 22%→18%**, having fallen at *every* re-measurement
  (25% → 22% → 20%).
- The 8th block fired on **"there is no second lane"** — a clause about a system's fallback path — in the
  most heavily-sourced message of the night.

**`effective: FALSE`.** It catches real errors *incidentally*; it cannot distinguish a claim's direction
from its surface form, and it blocks correct messages 3 times more often than incorrect ones.

## 3. #16 — CONFIRMED and STRENGTHENED (re-measured live 07:59Z)
`dryRun: false`, 109 ticks, 0 errors, **and it independently raised an episode at 07:06:26Z detecting the
version divergence I myself created by deploying at 07:02:56Z.** **A real violation, caught unprompted,
on current code.** Still the only instrument to produce evidence FOR.

## 4. #17 — still ❌, but the CAUSE MOVED
A0: *"permanently `critical` by construction."* **The metric is now fixed** (`critical` → `high`,
verified live). **It remains `effective: false` because the THRESHOLDS were calibrated to the broken
metric** — and it is now known to be the cause of the LLM-layer collapse, not merely of 21 dead jobs.

## 5. #6 / #7 — WORSE than at A0 time
A0 recorded codex revoked on the Mini and the Claude fallback at 32 attempts / 0 successes. **Now: 1,358
calls / 0 successes in 2h, on BOTH machines, every framework.** The failure has gone from partial to total.

---

> ## REVISED SCORE: **9 of 28 instruments effective** (was 10).
> The single change is #18, downgraded on stronger evidence — **not** on the LLM collapse, which turned
> out to invalidate none of them.
