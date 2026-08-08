---
title: "Guard Effectiveness Observability — the {looked, wouldAct, didAct} declare-or-fail obligation"
slug: "guard-effectiveness-observability"
author: "echo"
eli16-overview: "docs/specs/guard-effectiveness-observability.eli16.md"
approved: false
review-status: "MATERIALLY-FLAWED — adversarial review 2026-08-05; NOT ready for pre-approval"
---

# Guard Effectiveness Observability

> ## ✅ SCOPE RULED — 2026-08-05: option (a), narrow to the 28
>
> The operator ruled the fork at the window-7 cycle-1 pass: **apply the design to the 28 adoptable
> guards and report the 44 as structurally unverifiable, each with its named reason.** Delivered:
> `docs/audits/phase-b/guard-verifiability-28-and-44.md` — every one of the 44 carries an individually
> named, source-grounded reason, not a bucket label.
>
> **Option (b) — the chokepoint re-architecture — is NOT rejected.** It becomes a named Phase B branch
> requiring its own spec through full multi-model review, because it changes how Instar runs guards.
> **The two compose: nothing in (a) forecloses (b), and a guard moved onto a chokepoint by (b) simply
> changes class and becomes adoptable. The 28 is a floor, not a ceiling.**
>
> Remaining blockers below are unchanged: the schema itself is still undefined, and the harness is
> still a prerequisite. **The scope question is settled; the design question is not.**
>
> ## ⚠️ STATUS: DESIGN v3 — NOT READY TO BUILD
>
> This spec has been through two full design generations, both killed by review. **Nothing below
> describes v1 or v2** — they are at `docs/audits/phase-b/guard-observability-design-history.md`
> together with the reviews that ended them, because leaving superseded mechanics inline caused both
> the gate and human readers to evaluate dead designs as live ones.
>
> **What happened, in one line each:**
> - **v1 (manifest declaration)** — killed by adversarial review, verdict MATERIALLY-FLAWED: the
>   cheapest way to pass was to borrow an unrelated counter that already existed.
> - **v2 (registry ownership)** — killed by the conformance gate: it reduced borrowing to a
>   *reviewable* lie rather than an impossible one, which is willpower wearing a type signature.
> - **v3 (split the trust)** — current. The party that invokes a guard owns the "did it look" number;
>   the guard owns only its own verdict. Yields the mechanical invariant `didAct ≤ wouldAct ≤ looked`.
>
> **v3 is a direction, not a finished design.** The chokepoint survey is unstarted, and the
> staged-violation harness is a stated prerequisite. **Do not approve this to build yet.**
>
> **One instrument note worth keeping.** The deterministic conformance gate reported CLEAN on v1 while
> five material design holes sat in it. That is not a defect in the gate — it measures conformance to
> standards, not soundness of mechanism. But **"gate clean" must never be reported as "design
> validated"**, and I was one step from doing exactly that.

## Constitutional fit

**Parent standard: "Verify the State, Not Its Symbol" (The Substrate).** The standard requires that
for every detector or gate, the spec name the SYMBOL it reads, the STATE that symbol is claimed to
prove, the independent corroboration, and the explicit result when the symbol is unmeasurable. Today a
guard's inventory row reports **posture** (`enabled`, `lastTickAt`) and is read as **effectiveness** —
the symbol/state confusion the standard exists to forbid, applied to the very mechanisms that enforce
every other standard. This spec's whole purpose is to make that gap explicit and closeable.

**Also serves, directly:**

| standard | fit |
|---|---|
| **Structure beats Willpower** (Root & Fractal) | The v1→v2→v3 progression is this standard applied to itself: each version was rejected for depending on an author's or reviewer's diligence, until the obligation became arithmetic (`didAct ≤ wouldAct ≤ looked`). |
| **A Dark Feature Guards Nothing** (Shipping) | Its arm covers guards that are *dark*. This covers the sibling class the audit found unguarded — guards that are **on but uninspectable**, which currently raise nothing at all (see "The silent class"). |
| **Observability** (Building) | 62 of ~90 runtime guards are `not-instrumented` on two independent agents. This is the obligation that changes that number. |
| **Close the Loop** (The Substrate) | ⚠️ **Contradiction removed.** Earlier text here described "an exemption path that carries an expiry" — inherited from v2 and **false of v3**, which has no exemption or fallback path at all (a guard without caller-owned `looked` is `unverifiable-by-construction`, full stop). If any future revision reintroduces an exemption, the authority-binding and runtime-expiry problems from the killed designs return with it. |

**Fit rationale.** This spec does not introduce a new standard or a new principle. It applies an
existing constitutional requirement to the one part of the system that had been exempt from it — the
enforcement layer itself. **A constitution whose guards cannot be verified is a constitution enforced
on trust**, which is the condition Phase A measured and this phase exists to end.


## Problem statement

Instar ships **72 declared guards** (`GUARD_MANIFEST`). The `/guards` inventory can tell you whether
each one *exists* and whether it is *wired*. It cannot tell you whether any of them **works**.

Phase A of the Constitutional Alignment audit measured this directly. Of 90 runtime guards, **20 were
verifiable and 64 were unaskable** — not broken, *unaskable*. The audit's own closing finding:

> **Minimum honest schema for a guard's runtime row: `{looked, wouldAct, didAct}`. Two of the three is
> worse than none — it makes an uninterpretable zero look like health.**

### Why the gap exists, read from source

`guardStatus()` is a **convention, not a contract**. 26 files implement it, each returning its own
ad-hoc shape:

```ts
guardStatus(): { enabled: boolean; dryRun: boolean; lastTickAt: number }   // OwnershipReconciler
guardStatus(): { enabled: boolean; jobCount: number; pausedJobCount: number }  // JobScheduler
guardStatus(): { enabled: boolean; lastTickAt: number }                    // ×6 sentinels
guardStatus(): { enabled: boolean; dryRun: boolean; reason?: string }      // ResumeQueue
```

**Not one carries a would-act or did-act counter.** `lastTickAt` is a timestamp, not a count, so even
`looked` is only weakly present. The inventory row therefore reports *posture* and calls it *status*.

### The three failure modes this produces, all observed

1. **The ambiguous zero.** A guard reporting `0` cannot be distinguished from a guard that never ran.
   `lint-chain-completeness` already names this class exactly — *"a check whose absence is
   indistinguishable from its success"* — and ratchets against it for lints. Runtime guards have no
   equivalent.
2. **The partial surface.** `selfActionGovernor` exposes `1,616 wouldAct · 0 didAct`. That is
   interpretable *only because all three counters exist*. A guard exposing `didAct: 0` alone reads as
   health and is indistinguishable from a dead detector.
3. **Presence mistaken for truth.** `CrashLoopPauser` was classified in the manifest and **never
   constructed**, while 21 jobs failed — top **477 consecutive** — and none were paused. It stayed
   invisible because its exclusion rationale *asserts* an observability that does not hold, and
   `lint-guard-manifest.js` Assertion B checks only that a reason is **≥12 non-whitespace characters**
   (`MIN_REASON_NON_WS`), never that it is **true**.

### The silent class — measured on two agents, grounded in source

The codebase **already has a field for this**: `runtimeReason: 'not-instrumented'`
(`src/monitoring/guardPostureView.ts:74,240`). It knows which guards cannot be inspected. It simply
never requires any of them to become inspectable.

Measured live, 2026-08-05, on two independent agents running the same version (1.3.1126):

| | Echo (Mini) | Codey (Mini) |
|---|---|---|
| guard rows | 90 | 87 |
| `runtimeEnriched` | 26/90 | 17/87 |
| **`not-instrumented`** | **62** | **62** |
| loadBearing | 13 | 13 |
| **loadBearing AND not-instrumented** | **8** | **8** |

**62 on both, independently.** That corroborates Phase A's "64 unaskable" from a completely different
measurement path, and it matches the B0.2 census's 62 `none` exactly.

**And here is the gap inside the gap.** The summary emits `loadBearingUninspectableKeys` — a category
for exactly this problem. On both agents it is **empty**, while 8 load-bearing guards are
not-instrumented. The reason, read from source:

```ts
// src/monitoring/guardPostureView.ts:135
const LOAD_BEARING_UNINSPECTABLE_STATES: ReadonlySet<GuardEffectiveState> = new Set([
  'missing', 'errored', 'on-stale', 'on-blind', 'off-runtime-divergent',
]);
```

**`on-unverified` is not in that set** — and `on-unverified` is the state a guard lands in when it is
switched ON but has no runtime instrumentation. So a load-bearing guard that is *on*, *uninspectable*,
and *depended upon by a critical path* is counted as neither a gap nor uninspectable. **It raises
nothing.** Three guards sit in that silent class on Echo right now:

| guard | the critical path it protects |
|---|---|
| `monitoring.ropeHealth.enabled` | **mesh partition alerting** |
| `apprenticeship.stallCoverageGate.enabled` | apprenticeship onboarding sign-off |
| `multiMachine.seamlessness.ws13PinReplicate` | operator pin survives a lease change |

> **Stated carefully: these three are not known to be broken. They are structurally incapable of being
> known to work** — and because they are *on*, every surface reports them as fine. The guard that
> alerts you when your machines have partitioned is itself unverifiable, and nothing says so.

This is the concrete consequence the schema change removes, and it is why the obligation must be
*required* rather than encouraged.


## Design v3 — split the trust (supersedes v2's ownership model)

The gate's response to v2's honest correction was correct and forced the real answer: *"relies on code
review making that lie visible, rather than structurally preventing it."* That is willpower wearing a
type signature. So: who can lie about what?

> **v1/v2 both asked ONE party — the guard — to report all three numbers. A guard reporting on its own
> diligence is the conflict of interest at the centre of this whole problem.**

**v3 splits the counters by who can actually know them:**

| counter | owned by | why it cannot be faked by the guard |
|---|---|---|
| `looked` | **the CALLER** — the tick loop / governor / chokepoint that *invokes* the guard | The framework knows it invoked the guard. The guard is never asked, so it cannot inflate. |
| `wouldAct` | the guard | Only the guard knows its own verdict — irreducibly its to report. |
| `didAct` | **the ACTION path** — incremented where the side effect actually happens, not where it is decided | Separates *deciding* to act from *acting*; the existing dry-run split already lives here. |

### The invariant this buys — a mechanical check, not a reviewer's attention

```
didAct  ≤  wouldAct  ≤  looked
```

Every term is now denominated against a number the guard does not control. A guard that inflates
`wouldAct` past a framework-owned `looked` produces an **impossible row**, and impossible rows are
detectable by assertion — at request time, on live values, with no reviewer involved.

**This is the difference between "a lie is visible if someone looks" and "a lie is arithmetically
impossible to state consistently."** v2 achieved the former and I wrongly called it structural. v3 is
the structural version, and it exists because the gate refused the softer claim twice.

### The invariant tested against real data (not just asserted)

`selfActionGovernor` is the one guard already carrying this shape, and it is a **FUNNEL** guard — the
exact class v3 claims can have a caller-owned `looked`. Measured live on Echo, 2026-08-05:

| class | looked | wouldAct | `wouldAct ≤ looked` |
|---|---|---|---|
| 0 | 1790 | 1602 | ✅ |
| 3 | 10 | 4 | ✅ |
| 5 | 46 | 21 | ✅ |
| 6 | 184 | 57 | ✅ |
| 1,2,4,7,8 | 0 | 0 | ✅ |

**9 of 9 hold — but ⛔ THIS EVIDENCE IS WEAKER THAN I FIRST WROTE, and the correction matters.**

My original text said this was "meaningful evidence that a caller-owned `looked` is achievable." The
adversarial re-review read the source and refuted it: **`admits` is not a generic "looked" count.** It
increments in `recordAdmit` (`selfaction/governor.ts:1039-1043`), while **enforcing denials increment
`denies` WITHOUT calling `recordAdmit`** (`governor.ts:670-684`), and token-sink rejections can also
increment `denies` (`governor.ts:924-944`).

So `wouldDeny ≤ admits` holds **because this governor is currently observe-heavy** — nearly everything
is admitted. On an *enforcing* path the denominator relationship is not guaranteed at all.

> **I measured a real number and drew a conclusion the number did not support.** The arithmetic was
> right; the claim about what it demonstrated was wrong, and it was already committed and reported
> before the review caught it. Recorded rather than quietly amended.

**What this does NOT test, stated:** only the `wouldAct ≤ looked` half was verified. The `didAct` field
name on this route was not resolved, so `didAct ≤ wouldAct` is **untested** here. Reporting a
half-verified invariant as verified would be this document's own recurring error, so it is written down
as half.

Note also: **4 of 9 classes read `looked: 0`** — genuinely idle, and now *legibly* idle rather than
silently so. That is the reporting improvement v3 delivers even before any effectiveness claim exists.

### What v3 costs, honestly

- **It is a bigger change than v2.** Framework-owned `looked` requires a common invocation point per
  guard family. Instar has real chokepoints (the scheduler tick loop; `SelfActionGovernor`'s admission
  funnel), but they do **not** cover all 72 guards uniformly, and I have not surveyed which do.
- **Guards without a common caller get NO fallback.** ⚠️ **Corrected again:** my first draft of v3 let
  them self-report `looked`, tagged with a provenance field. The gate rejected it — *"leaving an
  important effectiveness signal dependent on the guard's own honesty"* — and it was right. A
  degraded-but-accepted number is exactly the compromise that produced every defect in this document.
  **So the fallback is removed, not labelled.** A guard with no framework-owned `looked` is
  `unverifiable-by-construction`: it may not claim effectiveness at any level, and the row says so.
  *(This is the "remove the sharing rather than improve the estimate" move. It also creates the right
  pressure: the way to make a guard verifiable is to put it on a chokepoint, not to argue about its
  self-report.)*
### The floor — stated once, and NOT revised away

**`didAct` incrementing does not prove it fired for the RIGHT reason.** A guard could increment on a
timer. No arithmetic invariant, ownership model, or registration scheme closes this — **only staging a
known violation and watching the counter move for that reason does.**

This has been true in every version of this design and I have stopped trying to revise it away. It is
the **irreducible floor of a counter-based approach**, and it is precisely the boundary at which the
staged-violation harness stops being a nice-to-have and becomes the prerequisite.

> **What this spec can honestly deliver: a guard cannot be silently unverifiable, and cannot state a
> self-consistent lie about its own activity.**
> **What it cannot deliver: proof that a guard's activity was correct.**
>
> Reporting the first as though it were the second is the exact error this entire document exists to
> prevent, so it is written here rather than left to be inferred.

### What v3 did not specify — CLOSED above, retained for the record

A section-by-section check kept passing while this gap sat in plain sight, which is its own small
lesson. **v3 specifies the TRUST MODEL — who owns which number — and does not specify the SCHEMA.**
This document is titled after a schema. Concretely, still undefined:

- **The manifest-side declaration.** v2 had `expectCounters: boolean`; it left with v2. v3 has no
  replacement, so there is currently **no way to state that a given guard is expected to carry
  caller-owned counters** — and therefore no way to detect one that should and doesn't.
- **Where the caller's count lives.** `looked` is owned by the invoking chokepoint, but the data
  structure holding it (registry-side? per-key counter in `GuardRegistry`?) is unspecified.
- **What computes the verdict.** The stage-1 union is defined; the function mapping live counters to
  it is not.

**This gap is why the chokepoint survey blocks the schema, not merely informs it** — the survey's
answer (how many guards have a common caller today) determines whether the manifest declaration is a
boolean, an enum of invocation classes, or something else entirely. Designing the schema before that
number exists would be guessing, and this document has already demonstrated where guessing leads.

### The premise does NOT hold fleet-wide — measured, not assumed

v3 rests on caller-owned `looked`. The re-review checked whether that is achievable across the guard
population and the answer is **only for some families**:

| family | common invocation chokepoint? | evidence |
|---|---|---|
| `SelfActionGovernor` | **YES** — `admit`/`admitSync` both delegate to `core.admitFor` | `selfaction/governor.ts:1665-1680`, `:510-529` |
| `JobScheduler` job gates | **PARTLY** — `triggerJob` funnels several guard-like decisions, but for JOBS, not guards generally | `JobScheduler.ts:442-448`, `:568-717` |
| independent sentinels (most guards) | **NO** — each owns its own loop and reports *posture*, not invocation counts | `SessionReaper.ts:1265`, `SocketDisconnectSentinel.ts:301`, `ExternalHogSentinel.ts:297`, `OwnershipReconciler.ts:840` |

**And the manifest confirms the scale of the problem: of 72 entries, only 24 carry
`expectRuntime: true` — 48 are `false`.** Runtime registration already covers a minority, and
registration is not the same thing as a caller-owned evaluation count.

> **So v3's central mechanism is available to a minority of guards today.** That does not kill it — a
> guard *family* moving onto a chokepoint is a real, incremental path — but **it does kill any framing
> in which v3 is a schema change that can simply be applied to 72 entries.** It is an architectural
> change to how guards are invoked, for most of them.

**The survey has since landed and gives the definitive number** (`docs/audits/phase-b/chokepoint-survey.md`,
per-guard tracing with controls passed):

| invocation class | guards | caller-owned `looked` available today? |
|---|---:|---|
| TICK-LOOP | 19 | **yes** — a shared scheduler/interval invokes it |
| FUNNEL | 9 | **yes** — a shared admission chokepoint |
| EVENT-DRIVEN | 16 | no — scattered callsites, no common caller |
| SELF-DRIVEN | 26 | no — owns its own timer; nothing invokes it |
| UNKNOWN | 2 | undetermined (honestly reported, not guessed) |
| **total** | **72** | **28 feasible today** |

> ### 28 of 72 — and as of the cycle-1 ruling, this IS the scope.
>
> **39% of guards can adopt this design without new plumbing. The other 44 would need to be
> re-architected to be invoked through something.** The reviewer reached a similar magnitude
> independently by a different measure (24 of 72 carry `expectRuntime: true`).
>
> **RULED: (a) now, (b) as its own branch.** The operator's reasoning, recorded because it is the
> load-bearing argument: reporting 44 guards as structurally unverifiable with named reasons is
> *strictly more honest* than 44 green lights nobody can question. **Option (a) is not a failure
> mode**, and (b) is not rejected — it is held to the plan's full discipline rather than settled in a
> single pass.

### Status of v3

**Direction, not a finished design — and after two adversarial reviews, not even the right SHAPE of
design.** ⚠️ *(A dead draft fragment referencing `lookedProvenance` lived here until the re-review
caught it. It described the self-reported fallback that v3 had already removed — exactly the class of
compromise v3 exists to reject. Removed, and noted because a stale sentence describing a rejected
compromise is how a rejected compromise creeps back.)*

**The honest conclusion after two hostile reads: this is not a schema change.** A schema change can be
applied to 72 manifest entries. This requires most guards to be invoked through a chokepoint they do
not currently have — an **architectural change to how guards run**, available to a minority today.
**That is a plan-level decision, not an authoring one**, and it belongs to the architect.

---

## THE SCHEMA — the gap this document was named after, now closed (2026-08-05, post-ruling)

Scope is settled (the 28), so the schema can finally be specified rather than gestured at. **A
measurement drove the shape:** the 28 guards have **25 distinct caller mechanisms** — `server`
intervals, `MultiMachineCoordinator` lease-pull ticks, `SelfActionGovernor.admit`, `StateManager`'s
write funnel, and twenty-one more. There is almost no sharing.

**So "the caller increments `looked`" would mean 25 callsites each remembering to increment.** That is
the willpower pattern this project has rejected six times tonight. Rejected again here.

### Count at the INVOCATION, not at the caller

The registry supplies the wrapper the caller invokes *through*, so the count is a property of the call
rather than a duty of the callsite:

```ts
// src/monitoring/GuardRegistry.ts — extends the EXISTING registry.
// The caller changes from   guard.tick()
//                     to    registry.invoke('monitoring.foo.enabled', () => guard.tick())

invoke<T>(key: string, run: () => T): T {
  this.counters(key).looked++;          // owned by the REGISTRY — neither guard nor caller writes it
  return run();
}

/** The guard reports ONLY its own verdict. It cannot reach `looked` OR `didAct`. */
verdict(key: string): GuardVerdictSink {
  const c = this.counters(key);
  return { wouldAct: () => { c.wouldAct++; } };   // wouldAct ONLY
}

/** `didAct` belongs to the ACTION PATH, counted only AFTER the side effect
 *  actually completes. MUST be await-correct: several in-scope action paths
 *  are async (e.g. TelegramAdapter.createForumTopic, TelegramAdapter.ts:1489). */
async act<T>(key: string, perform: () => T | Promise<T>): Promise<T> {
  const result = await perform();    // the side effect COMPLETES first
  this.counters(key).didAct++;       // ...and only then is it counted
  return result;
}
```

⚠️ **Two corrections from the re-review, both of which I had got wrong:**

**(a) It was sync-shaped, which broke the property it existed to provide.** `perform(): T` returning a
Promise would have incremented `didAct` **when the Promise was created**, not when the side effect
succeeded — the exact "counted an action that did not happen" this wrapper exists to prevent, in the
wrapper. In-scope async paths make this live, not theoretical: `createForumTopic` is `async` and its
effect is awaited later (`TelegramAdapter.ts:1489-1543`).

**(b) The capability restriction was a CONVENTION, not a capability.** I wrote that "the guard cannot
reach `didAct`." But `GuardRegistry` is an ordinary exported mutable class, constructed once at boot and
**threaded as a whole object into server and route contexts** (`server.ts:6941-6945`,
`AgentServer.ts:709-710, 3748-3756`, `routes.ts:1517-1521`). A public `act()` on that object is callable
by anything holding `ctx.guardRegistry` — including a guard.

**So the split must be a capability split, not a method-naming convention:**

```ts
// Guard code receives ONLY this. It is not the registry.
export interface GuardVerdictSink { wouldAct(): void }

// Side-effect seams receive ONLY this, and only where the effect happens.
export interface ActionSink { act<T>(perform: () => T | Promise<T>): Promise<T> }
```

Each is a **narrow handle minted per key and handed to exactly one party** — the registry itself is
never passed to guard code. Otherwise the trust split is enforced by everyone agreeing not to call the
method that is right there, which is the definition of willpower.

> **Ninth and tenth times in this document that I claimed a structural property and delivered a
> convention.** The tell is identical each time: I describe what the code *should* be used for instead
> of what it *permits*. **A capability is what the holder CAN do, never what the design intends.**

⚠️ **The first draft of this schema handed the guard a `didAct()` it could call directly — and the gate
caught it.** That silently reverted v3's entire trust split: the whole point is that the party which
*decides* to act is not the party that *records having acted*. A guard could have incremented `didAct`
on the line where it decided, with no side effect anywhere.

**Eighth time in this document that a fix quietly re-introduced the defect it was fixing.** The pattern
is consistent enough to state as a working rule: **when I write the implementation of a principle, I
tend to collapse the very distinction the principle exists to hold** — because the collapsed version is
simpler and reads fine. Only an outside check has caught it, every time.

**Why a wrapper beats an increment call, concretely:**

| | caller increments | registry wraps the invocation |
|---|---|---|
| a callsite that forgets | **silently undercounts** — looks like an idle guard | **impossible**: no wrapper, no invocation |
| who owns `looked` | the caller (25 of them) | **the registry** — one owner |
| can the guard reach `looked`? | yes, it is just a counter | **no** — its handle (`GuardVerdictSink`) exposes `wouldAct` **only** |
| adoption is visible? | a missing line looks like nothing | **a guard still called directly is greppable** |

That last row is the one that matters — but ⚠️ **my first statement of it was wrong, and I caught it by
testing my own claim.**

I wrote that a directly-invoked guard is *"a lint-findable callsite."* **It is not reliably findable.**
`src/commands/server.ts` alone holds **39 `setInterval` sites** in at least three shapes — a bare
function reference (`setInterval(refreshTestRunnerGuard, 60_000)`), a one-line arrow
(`setInterval(() => { void cjScan(); }, ms)`), and multi-line block bodies. A lint that parses source as
TEXT (which this one must — it cannot import TS) would have to recognise every shape, and a guard
invoked three lines inside a block body is not a pattern.

**The real detector is runtime reconciliation, and it is stronger than grep.**

A guard that declares `invocation: 'tick-loop'` and reports **`looked === 0` after the process has been
up longer than 5× its `expectedTickMs`** is provably not being invoked through the wrapper. The manifest
already carries `expectedTickMs`; the staleness window already exists; `/guards` already reconciles
declared-versus-registered to produce `missing`.

| | lint (my first claim) | runtime reconciliation |
|---|---|---|
| detects a bypassed wrapper | unreliably — must match every call shape | **yes** — the counter simply never moves |
| detects a guard that stopped being called | no | **yes** — same signal |
| needs new machinery | a new parser | **none** — same shape as `expectRuntime` → `missing` |
| can be evaded by writing the call differently | yes | **no** — evasion requires actually invoking it, which increments |

⛔ **AND THAT STATEMENT WAS ALSO TOO STRONG. The re-review refuted it — this is the ninth instance of
the phase's own defect, in my own detector.**

`looked === 0` **measures** "no counted invocation." I **certified** it as "not going through the
wrapper." Those are different sets, and the gap contains at least five states:

| `looked === 0` can mean | is it a bypass? |
|---|---|
| the guard is invoked directly, bypassing the wrapper | **yes** — the case I wanted |
| the guard is **disabled** in config | no — classified before staleness today (`guardPostureView.ts:299-305`) |
| it is a **FUNNEL** guard and no request arrived | no — legitimate idleness |
| the machine is **standby**, so the loop was never constructed | no — e.g. the scheduler is built only under `isAwake` (`server.ts:7031-7034`) |
| the **process just started** | no — and `/guards` passes `now` but **no uptime input at all** (`guardPostureView.ts:361-369`) |

**The inputs are also missing, not merely unmodelled.** `expectedTickMs` is absent for **8 of the 19**
TICK-LOOP guards (`holdForStability`, `staleOwnerRelease`, `preferredCaptainHandback`, `promptGate`, …),
and **most FUNNEL guards have no cadence at all** — correctly, because a traffic-driven admission path
has no period. A `5 × expectedTickMs` rule is meaningful for a periodic loop and **meaningless for a
funnel**.

### The claim, narrowed to what is actually true

> For **an enabled tick-loop guard**, with **a declared `expectedTickMs`**, **a registered counters
> row**, on a process **continuously eligible/awake for more than 5 × that cadence** — `looked === 0`
> is strong evidence of no wrapped invocation.

Everything outside that conjunction is **`adoption-unknown`**, not `never-evaluated`. And the schema
must carry the inputs the conjunction needs — **process uptime and eligibility-window are new required
inputs to the verdict computation**, not incidental context.

### ⛔ `eligibleForMs` DOES NOT EXIST — this is a prerequisite, not an assumption

The conjunction above requires **uptime and a continuous-eligibility window**. Neither is threaded into
the posture pipeline today: `/guards` passes `now` and nothing else (`guardPostureView.ts:361-369`,
`routes.ts:8703-8708`), while awake/standby gating that determines whether a guard loop exists at all
lives elsewhere entirely (`server.ts:7031-7034, 7101-7102, 10742-10746`).

**So `never-evaluated` is unreachable until that input is built** — every `looked === 0` resolves to
`adoption-unknown` in the interim. That is the correct degradation (unknown, not a false verdict), but
it must be stated as a **build prerequisite** rather than assumed available. Adding it to the
implementation surface list below.

**FUNNEL guards need a different detector entirely.** Their `looked === 0` is indistinguishable from a
quiet day, so adoption for the nine must be established at conversion time (the callsite goes through
`registry.invoke` or it does not — a code-review fact) rather than inferred from runtime counters.

> **Three attempts at this one claim: "impossible" → "greppable" → "provable at runtime."** Each was
> narrower and each was still wider than the evidence. The honest version is a five-clause conjunction
> covering 11 of 72 guards. **I keep reaching for the strongest phrasing the finding will bear, and it
> keeps bearing less than I reach for.**

### The manifest declaration

```ts
export interface GuardManifestEntry {
  // ... existing fields unchanged ...

  /** How this guard is invoked — determines whether a caller-owned `looked` can
   *  exist at all. Sourced from the chokepoint survey; REQUIRED, no default. */
  invocation: 'tick-loop' | 'funnel' | 'event-driven' | 'self-driven' | 'unknown';

  /** REQUIRED when invocation is 'tick-loop' | 'funnel': what ONE `looked`
   *  increment means for this guard. Binds the number to its subject without
   *  standardising semantics across guards. */
  lookedMeans?: string;
}
```

`invocation` is required with no default — the `COMPONENT_CATEGORY` rule. A guard declaring
`tick-loop` or `funnel` **must** be reachable through `registry.invoke`. *(An earlier draft called a
direct call "the lint's failure case" — stale, and removed: the lint parses manifest classification
only (`lint-guard-manifest.js:104-150, 202-250`) and has no adoption rule. Adoption is established at
conversion time for funnels and by the narrowed runtime conjunction for tick-loops.)* A guard declaring `event-driven`, `self-driven`, or
`unknown` is `unverifiable-by-construction` and carries the named reason already published in
`docs/audits/phase-b/guard-verifiability-28-and-44.md`.

### What computes the verdict

Derived at request time from live counters — never cached, never stored (anti-decay, node-contract
rule 5):

```
invocation ∈ {event-driven, self-driven, unknown}   →  unverifiable-by-construction
no counters registered, invocation ∈ {tick,funnel}  →  missing-counters
!(didAct <= wouldAct <= looked)                     →  inconsistent
looked > 0                                          →  instrumented

// looked === 0 does NOT resolve on its own. It requires the full conjunction:
looked === 0
  && invocation === 'tick-loop'          // funnels are traffic-driven; 0 is normal
  && configEnabled                        // a disabled guard legitimately never looks
  && expectedTickMs != null               // 8 of 19 tick-loops have none
  && eligibleForMs > 5 * expectedTickMs   // uptime AND awake-window, not just `now`
                                          →  never-evaluated
looked === 0, any clause unmet            →  adoption-unknown
```

⚠️ **The previous revision fixed this claim in prose and left the table implementing the wide
version** — `looked === 0 → never-evaluated`, unconditionally. The narrowed conjunction was written
three paragraphs above the code that contradicted it. **That is the stale-artifact pattern, in the
document that keeps cataloguing the stale-artifact pattern.** `adoption-unknown` is now a first-class
verdict rather than a sentence.

**Stage one stops there.** `effective-candidate` and its siblings do not exist in the union until the
staged-violation harness lands — the forbidden claim is unrepresentable rather than prohibited.

### The wrapper FITS — verified against real callsites (adversarial review, 2026-08-05)

The first positive finding this design has earned. An independent reviewer traced five of the 28 to
source and confirmed each has **a single invocation expression the registry can bracket**:

| guard callsite | the bracketable expression |
|---|---|
| server interval | `topicReachabilityVerifier.tick()` — one call in one callback (`server.ts:10024-10027`) |
| lease-pull rider | `attachLeasePullTickListener(() => ropeProber.onTick())` (`server.ts:5740`) |
| WS13 reconciler | `runWs13Tick(...)` → `reconciler.tick()` once per pass (`server.ts:20690-20694`) |
| SelfActionGovernor | both handle methods delegate to one `core.admitFor(...)` (`governor.ts:1672-1679`, core at `:510-529`) |
| StateManager funnel | writes already centralised; one `wa.guardStoreWrite(...)` (`StateManager.ts:180-214`) |

**And the codebase supplies its own precedent for the design choice.** The reviewer noted that
`StateManager` already handles **eleven `saveSession` callsites through a single `saveSession` funnel**
(`StateManager.ts:296-304`) — the code having previously learned, in a different context, that
per-site wiring drifts and a funnel does not. **This is propagation of a lesson the codebase already
paid for**, which is the charter's framing, arrived at by a reviewer who was not looking for it.

### Honest cost — CORRECTED upward by the same review

I wrote *"~25 callsite conversions plus one registry change."* **The second half is materially wrong.**
Four surfaces need changes, and none currently has the needed shape:

| surface | current state |
|---|---|
| `GuardRegistry` | getter-only — `register`/`has`/`registeredKeys`/`read`. **No `invoke`, no `verdict`, no counters map** (`GuardRegistry.ts:40-71`) |
| `GuardManifestEntry` | **no `invocation`, no `lookedMeans`** (`guardManifest.ts:24-65`) |
| `guardPostureView` | no `GuardObservabilityVerdict`; still projects `effective` (`guardPostureView.ts:27-37, 66-74`) |
| `lint-guard-manifest.js` | **no wrapper-adoption rule at all** (`:202-250`) |

**And four is still short.** A neutral observability verdict cannot simply appear on a row — it has to
travel: `/guards` response assembly (`routes.ts:8710-8718`), pool forwarding (`routes.ts:8780-8793`),
the heartbeat posture type (`types.ts:2311-2340`), and existing consumers of `effective`
(`CapabilityIndex.ts:123-131`, `ApprenticeshipStallGate.ts:807-845`).

**Plus a normative wiring constraint, not just a type:** an `ActionSink` must never be placed on the
broad server/route contexts where funnel guard code already lives (`routes.ts:1517-1521, 3174-3183,
24587-24599`; `AgentServer.ts:709-710, 3105-3118, 3748-3756`). Declaring two interfaces achieves
nothing if both are reachable from the same `ctx`. **The capability split is a wiring rule; the types
only describe it.**

**So: ~25 callsite conversions across FOUR surfaces, not one.** Recorded because an understated
estimate is how a day of work becomes a surprise mid-build — and because I produced the understatement
by counting the change I had designed rather than the changes it requires.

### ⚠️ The health-colouring hazard is worse than I recorded

I noted that stage-one `instrumented` must not be rendered under a health-coloured field. The reviewer
sharpened it: **the existing state union is *entirely* health-coloured** (`on-confirmed`, `on-stale`,
…) and the row field is literally named `effective` (`guardPostureView.ts:27-37, 66-74`). There is no
neutral place to put an observability verdict today.

So the wrapper alone does not defeat the v3 attack — **it relocates the false-health value from
`effective` to `instrumented`**, and if `instrumented` lands in a field named `effective`, nothing has
been gained. **The new verdict needs its own field, not a new value in the old one.**


## Prerequisite — the staged-violation harness comes FIRST

**Corrected ordering (2026-08-05).** The Phase B tree originally placed the staged-violation harness
after this schema change. That was wrong, and both the adversarial review and the conformance gate
converged on why:

> A counter proves a guard is *instrumented*. Only a staged violation proves the counter is *honest*.
> **Shipping the schema first would produce 72 guards that can all report numbers nobody can trust** —
> which is a more expensive version of today's problem, not a fix for it, because the numbers would
> then carry an unearned appearance of rigour.

So the dependency is stated as binding:

1. **Harness first** — the ability to stage a known violation against a guard and observe the result.
2. **This schema second** — so every counter it introduces is falsifiable from day one.
3. **No effectiveness claim** — from this surface or any consumer of it — until (1) exists.

Until the harness exists, this schema's honest ceiling is **`unverifiable-by-construction` vs
`instrumented`**. That distinction is worth having on its own (it is strictly more than today's
silence), but it is *not* an effectiveness verdict.

### And that ceiling is enforced by the TYPE, not by this paragraph

⚠️ **Corrected — the gate caught this sentence.** An earlier draft said consumers "must never render
instrumentation as an effectiveness verdict." **That is a wish, and this document is supposed to know
better by now.** A prose prohibition is precisely the failure mode every version of this design was
rejected for.

So the verdict vocabulary is **shipped in two stages, and stage one does not contain the words**:

```ts
// Stage 1 — what ships WITH this schema. Note what is absent.
type GuardObservabilityVerdict =
  | 'unverifiable-by-construction'   // no framework-owned `looked` exists for this guard
  | 'instrumented'                   // counters registered and arithmetically consistent
  | 'never-evaluated'                // instrumented, looked === 0
  | 'inconsistent';                  // the invariant didAct <= wouldAct <= looked is VIOLATED

// Stage 2 — added ONLY when the staged-violation harness exists.
//   | 'effective-candidate'
//   | 'wired-not-effective'
//   | 'evidence-backed-unmeasured'
```

⚠️ **And the field it renders into matters as much as the value.** The existing `/guards` surface
already names posture under a field called `effective` (`guardPostureView.ts:66-74`). Rendering
`instrumented` there would be read as health by every existing consumer — the exact overread this
whole document is trying to prevent, delivered by field name rather than by value. **The stage-one
verdict must NOT be surfaced under `effective` or any health-coloured posture field.**

**A consumer cannot render `effective-candidate` before the harness lands, because the value does not
exist to render.** No discipline required, no reviewer needed, no way to forget. The prohibition is
the absence of the symbol — which is, finally, the same move the whole design converged on.

## Design history

v1 (manifest declaration) and v2 (registry ownership) are retained at
`docs/audits/phase-b/guard-observability-design-history.md` with the reviews that killed them.
