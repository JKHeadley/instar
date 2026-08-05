---
title: "Guard Effectiveness Observability — the {looked, wouldAct, didAct} declare-or-fail obligation"
slug: "guard-effectiveness-observability"
author: "echo"
eli16-overview: "docs/specs/guard-effectiveness-observability.eli16.md"
approved: false
review-status: "MATERIALLY-FLAWED — adversarial review 2026-08-05; NOT ready for pre-approval"
---

# Guard Effectiveness Observability

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

### What v3 does NOT yet specify — found by reading the whole document

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

This is exactly the number the chokepoint survey was dispatched to produce, arrived at independently by
the reviewer first. Where the survey disagrees, the survey's per-guard tracing wins.

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
