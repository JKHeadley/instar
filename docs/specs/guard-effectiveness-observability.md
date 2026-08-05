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
| **Close the Loop** (The Substrate) | The exemption path carries an expiry so an "unverifiable" claim cannot sit unreviewed forever. |

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

### Status of v3

**Direction, not a finished design.** The chokepoint survey (which guards have a common caller?) is
unstarted, and the fallback's honesty depends on `lookedProvenance` being carried through the whole
surface. **This section is the design's current best answer and is explicitly not ready to build.**

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

**A consumer cannot render `effective-candidate` before the harness lands, because the value does not
exist to render.** No discipline required, no reviewer needed, no way to forget. The prohibition is
the absence of the symbol — which is, finally, the same move the whole design converged on.

## Design history

v1 (manifest declaration) and v2 (registry ownership) are retained at
`docs/audits/phase-b/guard-observability-design-history.md` with the reviews that killed them.
