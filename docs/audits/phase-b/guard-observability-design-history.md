# Guard Observability — design history (v1, v2) — SUPERSEDED

**These designs are NOT current.** They are retained because the adversarial review and the
conformance gate were run against them, and the findings only make sense next to what was proposed.
The current design is v3 in `docs/specs/guard-effectiveness-observability.md`.

**Why they were moved out of the spec:** while v1/v2 sat inline under "retained for review", the
conformance gate read them as live claims and raised findings against superseded text. A spec must
state ONE design. History belongs in history.


## Design v2 — superseded by v3 above, retained for review (2026-08-05, post-adversarial-review)

The adversarial review's finding 3 is not patchable, because it is not a bug in the check — it is a bug
in **where the obligation lives**.

> **v1 put the obligation in the MANIFEST — a *declaration*. A declaration names a route and a dotted
> path, and a path can point anywhere: at `JobScheduler.jobCount`, at any pre-existing positive number.
> The author controls it, so it can be borrowed.**
>
> **v2 puts the obligation in the REGISTRY — a *registration*.** `GuardRegistry.register(key, getter)`
> (`src/monitoring/GuardRegistry.ts:44`) already requires a component to register a **synchronous
> in-memory getter** for a manifest key it owns. The natural way to write that getter is a closure over
> the component's **own instance state**.
>
> ⚠️ **CLAIM CORRECTED — do not read this as "impossible".** My first draft of v2 said the borrowing
> attack "has no surface". **That is false, and the gate caught it.** A getter is a *function*: a
> component can still write `() => ({ effectiveness: someOtherComponent.count })`. What actually
> changes is the **cost and the visibility**:
>
> | | v1 (declaration) | v2 (registration) |
> |---|---|---|
> | borrowing costs | changing a **string** in a manifest | **writing code that lies** |
> | visible in review | no — a dotted path looks like any other | **yes — it appears in the diff as a wrong reference** |
> | caught by the compiler | no | no |
> | caught by a reader | unlikely | **likely** |
>
> **v2 converts an invisible, frictionless attack into a deliberate and reviewable one.** That is a
> real improvement and it is the honest size of it. It is not a proof, and this spec must not be read
> as claiming one.

This is the same move that ended the rounds-1-to-4 spiral: stop making the check harder to fake and
take the thing out of the author's control entirely.

### v2 schema — extend the EXISTING runtime contract

```ts
// src/monitoring/GuardRegistry.ts — GuardRuntimeStatus already exists and
// already flows to the /guards row as `runtime`. Add the triple to it.
export interface GuardRuntimeStatus {
  enabled: boolean;
  dryRun?: boolean;
  lastTickAt?: number;
  // ... existing fields unchanged ...

  /** Effectiveness counters. Present TOGETHER or absent TOGETHER — the
   *  nested object makes "two of three" unrepresentable, same as v1, but
   *  now over values the component OWNS rather than paths it names. */
  effectiveness?: {
    looked: number;
    wouldAct: number;
    didAct: number;
    /** What one `looked` increment means FOR THIS GUARD. Binds the subject
     *  (Quantitative Claims Must Bind a Subject) without standardising
     *  semantics across guards. */
    lookedMeans: string;
  };
}
```

```ts
// src/monitoring/guardManifest.ts — one boolean, mirroring the existing
// `expectRuntime` reconciliation pattern exactly.
export interface GuardManifestEntry {
  // ... existing fields unchanged ...

  /** True where this guard MUST report effectiveness counters. A guard with
   *  expectCounters:true that registers a getter WITHOUT `effectiveness`
   *  reconciles to the new `missing-counters` state — the same way
   *  expectRuntime:true with no registration already reconciles to `missing`
   *  (guardManifest.ts:42-47). Registration is not effectiveness. */
  expectCounters: boolean;
}
```

### Why v2 answers each material finding

| finding | v2 answer |
|---|---|
| **3 — borrowed counters** | **Dissolved.** There is no path to borrow; a getter closes over its own component. |
| **1 — unbound `ratificationRef`** | **Shrunk to near-nothing.** `expectCounters: false` is a much smaller claim than "this guard can never be verified", and it is contradicted at runtime the moment the guard registers counters anyway. The exemption stops being the load-bearing part of the design. |
| **2 — expiry fails build not runtime** | **Dissolved.** `missing-counters` is computed **at request time** from live registry reconciliation (`/guards` already builds rows per request, `routes.ts:8689`). There is no build-time-only claim left to go stale on a deployed agent. |
| **5 — lint cannot parse nested unions** | **Dissolved.** The nested shape now lives in TypeScript, checked by the **compiler**. The lint's only new job is a boolean field — well within its existing regex-over-text parser. |
| **4 — 153-entry migration** | **Reduced to 72 booleans + instrumentation work.** `NOT_A_GUARD` needs no observability declaration at all under v2, because it holds things that are *not guards* and therefore register nothing. *(The ≥12-char `reason` defect on that list is a real, separate problem — it belongs to its own node and must not be smuggled into this one.)* |

### What v2 still does NOT establish — stated, not buried

A registered counter proves the number is the component's own. **It does not prove the component
increments it correctly** — a guard could register `effectiveness` and never increment `looked`.

**But a frozen counter is not hidden — it is visible as its own value.** Because the getter returns
live numbers rather than a declaration, `looked: 0` at request time IS the observation that the guard
has never evaluated anything. The surface therefore distinguishes:

| live read | honest verdict |
|---|---|
| no `effectiveness` block, `expectCounters: true` | `missing-counters` — the obligation is UNMET |
| `effectiveness` present, `looked: 0` | `never-evaluated` — registered and provably idle |
| `looked > 0`, `wouldAct: 0` | `evidence-backed-unmeasured` — it looked and found nothing |
| `looked > 0`, `wouldAct > 0`, `didAct: 0` | `wired-not-effective` |
| `looked > 0`, `didAct > 0` | `effective-candidate` — **never `effective`** |

**So registration alone never satisfies the obligation in the sense that matters.** It satisfies the
*declaration*; the live values then report the truth, including the unflattering ones. A guard that
registers counters and never touches them lands in `never-evaluated`, which is strictly louder than
today's silence — today it would read `on-unverified` and look fine.

What remains genuinely unproven is whether a *moving* counter moves **correctly** — whether `didAct`
increments on the right condition rather than on a timer. That is only falsifiable by **staging an
evaluation and watching the counter move for a known reason**, which is the staged-violation harness. **So the honest dependency is: verifying a counter is HONEST requires the
harness; making a counter UNBORROWABLE does not.** v2 delivers the second and is explicit that it does
not deliver the first. The tree's ordering is corrected accordingly — the harness moves ahead of the
"claim a guard is effective" work, though not ahead of this schema change.

**Everything below this line is design v1, retained unedited for review against what was proposed.**

---

## Proposed design (v1 — SUPERSEDED)

**This is a propagation, not new machinery.** Every element below already exists and is verified by
injection somewhere in this codebase. The change applies them to one register that lacks them.

### The pattern being propagated

Phase A named the strongest structure in the codebase precisely:

> **ONE undeclared key in `COMPONENT_CATEGORY` fails SIX independent ratchets. One shared REGISTER,
> six declare-or-fail obligations, no default on any.**

`GuardManifestEntry` is the same shape — a register with obligations, enforced by an existing lint
that already bites (`lint-guard-manifest.js`, Assertion A: every candidate appears in exactly one of
`GUARD_MANIFEST` / `NOT_A_GUARD`). It is missing the obligation that matters most.

### 1. The schema change

Add one **required** field to `GuardManifestEntry`:

```ts
export interface GuardManifestEntry {
  // ... existing fields unchanged ...

  /** ── Effectiveness observability (REQUIRED — no default) ──
   *  Where this guard's rung-3 evidence lives. A guard that cannot answer
   *  this is verifiable at rung 2 (WIRED) and never rung 3 (EFFECTIVE).
   *  There is deliberately NO default: an omitted field fails to compile
   *  and fails the lint (COMPONENT_CATEGORY precedent). */
  observability: GuardObservability;
}

export type GuardObservability =
  | {
      kind: 'counters';
      /** Authed route serving the counters, e.g. '/self-action-governor'. */
      route: string;
      /** Dotted path into that route's response body for each counter.
       *  ALL THREE are required by the type — a partial surface is
       *  structurally undeclarable, per Phase A's "two of three is worse
       *  than none". */
      looked: string;
      wouldAct: string;
      didAct: string;
      /** REQUIRED: what ONE increment of `looked` means FOR THIS GUARD
       *  (e.g. "one session evaluated on one tick"). This does NOT
       *  standardise semantics across guards — it BINDS each number to its
       *  own subject, so a verdict is a claim about this guard only.
       *  Length-bounded, single-line (lint parses source as text). */
      lookedMeans: string;
    }
  | {
      kind: 'none';
      /** CLOSED SET — not free text. Narrows the space of declarable
       *  exemptions; see the honesty note below on what this does NOT do. */
      reason: ObservabilityExemption;
      /** Machine-checkable artifact backing the exemption: a commit SHA, a
       *  resolvable path, or a registry key. The lint verifies it RESOLVES —
       *  a NECESSARY, NOT SUFFICIENT condition (see below). */
      evidenceRef: string;
      /** REQUIRED on EVERY exemption: a PIN-gated operator ratification
       *  artifact. This is the ONLY verified principal available in this
       *  system — a VCS author string is settable and an agent identity can
       *  be self-asserted, so neither is an identity (Know Your Principal:
       *  an unverified identity is a guess).
       *
       *  The bar is deliberately high because the CLAIM is high: "this guard
       *  can never be verified effective" is precisely the claim that hid
       *  CrashLoopPauser while 21 jobs ran away. It should cost something.
       *
       *  Self-limiting by design: if a guard CAN be instrumented, adding
       *  counters is cheaper than obtaining a ratification — so the incentive
       *  gradient points toward observability rather than away from it. */
      ratificationRef: string;

      /** Attribution, NOT authority. The `git blame` author of this block, for
       *  audit trail only. The lint checks it matches the committing identity,
       *  but a match NEVER substitutes for `ratificationRef` — this field
       *  answers "who wrote it", never "who authorised it". */
      declaredBy: string;
      declaredAt: string;   // ISO-8601

      /** REQUIRED: the date this exemption EXPIRES. Past it, the lint FAILS and
       *  the entry must be re-ratified (a fresh PIN action) or instrumented.
       *
       *  An exemption is a standing claim that "this guard can never be verified".
       *  A claim like that must not be able to sit unreviewed forever just
       *  because nobody remembered to look — so the review cadence is ARITHMETIC,
       *  not discipline. This is the durable-output-chokepoint-ratchet pattern
       *  (pending sets are shrink-only and owner-bearing) applied to exemptions:
       *  the build itself resurfaces the claim on a clock.
       *
       *  Max 180 days from declaredAt, enforced by the lint — an author cannot
       *  set a 100-year expiry and call it a cadence. */
      ratifiedUntil: string;   // ISO-8601
    };

export type ObservabilityExemption =
  /** The guard's action IS its own durable auditable record (e.g. a reap-log
   *  row), so a separate didAct counter would be a second source of truth. */
  | 'action-is-its-own-record'
  /** The guard has no evaluation step to count — it is a constructor-time
   *  structural assertion, not a runtime evaluator. */
  | 'no-runtime-evaluation-step'
  /** No structural reason — the operator has simply ratified this guard as
   *  exempt. NOTE: every exemption already requires `ratificationRef`, so this
   *  member is for exemptions with no *structural* justification at all. */
  | 'operator-ratified-exception';
```

### What the mechanical checks do NOT establish (Verify the State, Not Its Symbol)

**Stated plainly, because the first draft of this spec got it wrong.** A closed-set `reason` plus a
resolving `evidenceRef` makes an exemption **harder to fake**. It does **not** make it **true**.

| the SYMBOL | the STATE it is taken to prove | can the symbol be present while the state is absent? |
|---|---|---|
| `reason` ∈ closed set | this guard genuinely cannot expose counters | **YES** — an author can pick the closest-fitting member of a three-item list for a guard that could perfectly well be instrumented |
| `evidenceRef` resolves | the referenced artifact substantiates the exemption | **YES** — a path can exist and contain nothing relevant |
| `looked/wouldAct/didAct` present | the guard's evaluation is observable | **YES** — a counter can be declared and never incremented |

So the mechanical layer is a **floor, not a proof**, and this spec must not be read as closing the
presence-vs-truth defect — only as **raising its cost and naming its owner**. Three consequences,
binding:

1. **Every exemption requires a PIN-gated `ratificationRef`, which an agent cannot produce.**
   `declaredBy`/`declaredAt` record *who wrote it* for the audit trail; they never establish *who
   authorised it*. Signal-vs-Authority applied honestly: the lint is the cheap deterministic signal, a
   **verified** principal holds the semantic authority.

   > **Four rounds, four versions of the same defect — and this is the spec's most useful artifact.**
   > The bar went: ≥12 characters → a closed set → any non-empty string → a `git blame` author → a
   > PIN. The conformance gate rejected the first four, each time correctly. Every version made the
   > symbol *harder to fake*; none made it *true*, because each was still something the author could
   > type. Only the PIN leaves the author's control.
   >
   > **I did not see this coming at any round.** Each fix felt like the fix. That is precisely why
   > "the check exists" and "the check bites" have to be measured separately — the author of a check
   > is the worst-placed party to judge which one they built, and this spec is a four-round
   > demonstration of that on its own text.
2. **The unmeasurable case is explicit.** A counter that cannot be read renders `unknown` **with the
   reason it could not be read** — never `0`. A fabricated zero is the original defect.
3. **An exemption is a standing claim, not a settled fact — and it EXPIRES.** `ratifiedUntil` (max 180
   days) makes the build itself fail once the claim goes unreviewed, so the re-audit cadence is
   arithmetic rather than someone's memory. B0.5's staged-violation harness is what can actually
   falsify an exemption; the expiry is what guarantees somebody is made to look. **No count in this
   spec should ever be reported as "guards verified".**

### Verdicts are per-guard and NOT comparable across guards (Quantitative Claims Must Bind a Subject)

`lookedMeans` exists because `looked` is **not one quantity**. For one guard an increment is "a session
evaluated"; for another it is "a tick elapsed"; for another "a candidate considered". Comparing them —
or summing them into a fleet number — would be a quantitative claim with no bound subject.

Therefore, binding:

- A derived `verdict` is a statement **about one guard on one machine**. It is never aggregated.
- The `/guards` surface must **not** emit a cross-guard total, average, or ranking over these counters.
  *(This is a deliberate constraint on the rendering, and the reviewers should check it holds.)*
- `lookedMeans` is what makes each verdict legible on its own terms **without** requiring the
  cross-guard semantic standardisation that Frontloaded Decision 6 defers.

**Why a discriminated union rather than three optional fields.** Three optionals permit exactly the
state Phase A identified as *worse than none* — a guard declaring `looked` and `didAct` but not
`wouldAct`, whose `didAct: 0` then reads as health. The union makes the partial state
**unrepresentable**: TypeScript refuses to compile a `kind: 'counters'` entry missing any of the three.
This is the same mechanism used for `gateMeans` in the gate-skip spec, and it is why the obligation is
enforced at authoring time rather than discovered at runtime.

### 2. The lint change

Extend `scripts/lint-guard-manifest.js` with three assertions, following the existing Assertion A/B
structure:

- **Assertion C — the obligation exists.** Every `GUARD_MANIFEST` entry declares `observability`. No
  default, no inference. *(Mirrors `COMPONENT_CATEGORY`'s no-default rule.)*
- **Assertion D — the exemption reason is closed-set.** A `kind: 'none'` entry's `reason` must be one
  of the three enum members. **This supersedes the ≥12-character check for this field.** Assertion B's
  length bar remains for `NOT_A_GUARD` and is addressed separately (see Open questions).
- **Assertion E — the evidence resolves.** A `kind: 'counters'` entry's `route` must exist in the route
  table; a `kind: 'none'` entry's `evidenceRef` must resolve. **An unresolvable ref fails the lint** —
  this is what makes the declaration a claim about reality rather than about itself. *(Necessary, not
  sufficient — Assertion F carries the sufficiency.)*
- **Assertion F — every exemption carries a VERIFIED authorisation.** A `kind: 'none'` entry must carry
  a `ratificationRef` resolving to a PIN-gated operator ratification. **An agent cannot produce one**,
  so an agent can never self-grant an exemption.
  ⚠️ **This took three rounds and the progression is the point.** The bar went ≥12 characters → a closed
  set → any non-empty string → a `git blame` author. The conformance gate rejected each one, correctly:
  every version made the symbol *harder to fake* and none made it *true*, because each was still
  something the author could type. Only the PIN leaves the author's control. **A VCS author string is
  settable (`git config user.name` is arbitrary; unsigned commits assert anything), so `git blame` is
  attribution, not identity.**
- **Assertion F2 — attribution is recorded but never load-bearing.** `declaredBy` must match the
  `git blame` author of the block. A match NEVER substitutes for `ratificationRef`. This field exists
  for the audit trail and for re-audit, and the lint must fail if it is ever consulted as authority.
- **Assertion G — the SIBLING field gets the same obligation.** `NOT_A_GUARD.reason` moves from free
  text (≥12 chars) to the SAME closed set + `ratificationRef` + `declaredBy`/`declaredAt` shape.
  **Assertion B's character-count bar is deleted, not weakened.**
  ⚠️ **Folded in at round 4 after the gate flagged the deferral, and it was right to.** The first draft
  left this to a later tree node. But it is the *same defect on a sibling field of the same file* —
  and `CrashLoopPauser`, the incident that motivates this entire spec, hid in **`NOT_A_GUARD`**, not in
  `GUARD_MANIFEST`. Fixing the manifest while leaving the list that actually concealed the failure
  would have shipped the fix past the bug.
  *(This does not require auditing every existing reason for truth — it requires each entry to
  re-declare under the stronger schema, which makes an untrue exemption expensive rather than free.)*
- **Assertion H — no exemption outlives its review.** `ratifiedUntil` is required, valid ISO-8601, and
  ≤180 days after `declaredAt`. **An expired exemption fails the build.** *(Added round 5: the gate
  correctly noted that a date without a resurfacing mechanism is a record, not a loop. Close the Loop
  says untracked equals abandoned — and a tracked-but-never-resurfaced claim is tracked in name only.)*
- **Assertion I — every counter binds its subject.** A `kind: 'counters'` entry must carry a non-empty,
  single-line `lookedMeans`. Prevents a verdict derived from a number with no declared subject.

### 3. The inventory surface

`/guards` rows gain an `observability` block derived from the manifest, and — where
`kind: 'counters'` — the live counter values read at request time (anti-decay: never cached).

```jsonc
{
  "key": "monitoring.selfActionGovernor",
  "state": "on-confirmed",
  "observability": {
    "kind": "counters",
    "route": "/self-action-governor",
    "looked": 1940, "wouldAct": 1616, "didAct": 0,
    "verdict": "wired-not-effective",     // derived, never asserted
    "readAt": "2026-08-05T04:31:12.004Z"
  }
}
```

`verdict` is **derived at read time** from the three counters:

| condition | verdict |
|---|---|
| `looked > 0 && didAct > 0` | `effective-candidate` — the guard acted; a rung-3 claim still needs its **B-case** (see below) |
| `looked > 0 && wouldAct > 0 && didAct === 0` | `wired-not-effective` — evaluated, concluded action, did not act (dry-run or observe-only) |
| `looked > 0 && wouldAct === 0` | `evidence-backed-unmeasured` — it looked and found nothing. **Materially stronger than bare "unmeasured"** |
| `looked === 0` | `never-evaluated` — ticks but its evaluation has not run |
| `kind: 'none'` | `exempt:<reason>` |

**`effective-candidate`, never `effective`.** A counter proves the guard acted; it does not prove the
guard acts *correctly*. Phase A's B-case rule is explicit: a catch without a negative control cannot be
distinguished from a guard that rejects everything. This schema is the cheap deterministic signal; the
rung-3 claim remains a judgment made against a staged violation (B0.5). **The surface must not let a
non-zero `didAct` be read as alignment** — see Decision points.

### 4. Migration

72 entries need a declaration. Per **Migration Parity**, existing agents receive this through the
update path, but the manifest is compile-time source — so the migration is authoring work, not a
runtime migrator. Sequence:

⚠️ **Scope corrected by measurement (B0.2 reconciliation).** This change touches **two** lists, and the
second is the larger one:

| list | entries | what it needs |
|---|---|---|
| `GUARD_MANIFEST` | **72** | the full `observability` declaration |
| `NOT_A_GUARD` | **81** | the upgraded `reason` (closed set + ratification + expiry) |
| **total touched** | **153** | |

I had been sizing this at 72. **`NOT_A_GUARD` is the bigger list**, and it is the one that actually
concealed `CrashLoopPauser`. A 153-entry all-at-once migration is not a single session's work, so the
sequencing below is the design's answer — **not** an optional field, which would reopen exactly the
loophole the union exists to close.

1. **New entries are strict from day one.** The type is required; a new `GUARD_MANIFEST` or
   `NOT_A_GUARD` entry cannot be added without a complete declaration. **The hole stops widening
   immediately** — this is the part that cannot be deferred.
2. **Existing entries are grandfathered with a HARD EXPIRY, not indefinitely.** Each pre-existing entry
   is admitted under a `legacyUntil` date. Past it, **the build fails**. The same arithmetic that
   forces exemption review forces migration completion — so the backlog drains on a clock rather than
   on someone's intention. *(This is the one place the design permits a transitional state, and it is
   bounded, dated, and build-enforced. A grandfather clause with no expiry would be the deferral this
   spec exists to make impossible.)*
3. The census (B0.2, landed) supplies the ground truth for which guards already expose counters, so
   most `GUARD_MANIFEST` declarations are transcription rather than discovery.
4. Guards with no counters today declare `kind: 'none'` **or** get instrumented. The split is a finding,
   not a formality: **it converts the 62 not-instrumented guards into a precise, owned worklist.**
2. The census (`.instar/phase-b/` — Codex lane, in flight) supplies the ground truth for which guards
   already expose counters, so most declarations are transcription rather than discovery.
3. Guards with no counters today declare `kind: 'none'` with a closed-set reason **or** get counters.
   The split is a finding, not a formality: **it converts F3's "64 unaskable" into a precise, owned
   worklist.**

## Decision points touched

Per **Judgment Within Floors**, every decision point is classified.

| # | decision point | classification | justification |
|---|---|---|---|
| 1 | **Does a manifest entry satisfy the observability obligation?** | **invariant** | Deterministic by design: a field is present and well-typed, or it is not. There are no competing signals. Enforced by compiler + lint. |
| 2 | **Is an exemption reason valid?** | **judgment-candidate** | ⚠️ **Reclassified in round 1** — the first draft called this `invariant`, and the conformance gate correctly flagged it: closed-set membership is a check on the *symbol*, and an author can pick the closest-fitting member for a guard that could in fact be instrumented. **Floor:** bounded action space (3 members); conservative default = reject; fallback ladder terminates at "lint fails, entry cannot land". **Arbiter:** the operator, via the PIN-gated `ratificationRef` — the only verified principal in this system. `declaredBy` records who *wrote* the entry and is never consulted as authority. The mechanical layer narrows the space; a verified principal decides. |
| 3 | **Does an `evidenceRef` resolve?** | **invariant** | Existence check against the filesystem/route table. Binary — and deliberately scoped to *resolution only*. It is a necessary condition for the exemption, never a sufficient one (see "What the mechanical checks do NOT establish"). Decision point 2 owns the sufficiency. |
| 4 | **Is a guard EFFECTIVE?** | **judgment-candidate** | This is the one genuinely competing-signals point, and the schema deliberately **does not decide it**. Floor: bounded action space (`effective-candidate` / `wired-not-effective` / `evidence-backed-unmeasured` / `never-evaluated` / `exempt`); conservative default = `never-evaluated` when counters are unreadable; fallback ladder terminates at the deterministic rung (`unknown` + the reason it could not be read). **Arbiter: the human/agent reading the row against a staged violation, never this surface.** |
| 5 | **What does a counter read failure mean?** | **invariant** | Fails to `unknown` with a named reason. Never to `0` — a fabricated zero is precisely the ambiguous-zero defect this spec exists to remove. |

Decision point 4 is the only one where a static rule would be the proven failure class, and it is the
one the design refuses to make.

## Multi-machine posture

| surface | posture | notes |
|---|---|---|
| `GuardManifestEntry.observability` (the declaration) | **unified** | Compile-time source. Identical on every machine by construction — it ships in the package. |
| Live counter values on a `/guards` row | **proxied-on-read** | Counters are per-machine runtime state. `/guards?scope=pool` already merges per-machine posture; the observability block rides that same merged read, each machine's counters tagged with its `machineId`. |
| The derived `verdict` | **proxied-on-read, per-machine** | Phase A's amendment is load-bearing here: `orphanedWorkSentinel` is **blind on the Mini and OFF on the laptop** — one guard, two states, and a fleet-wide verdict would have been wrong about both. A verdict is therefore computed **per machine and never aggregated into a single fleet answer**. |

No surface in this spec is machine-local, so no `machine-local-justification` marker is required.

**Cross-machine hazard, stated:** a node cannot claim `aligned` from one machine's counters. The
inventory must render a per-machine breakdown, and a single-machine row must be structurally incapable
of rendering as fleet-aligned.

## Frontloaded Decisions

Decisions made here so the build does not stop to ask:

1. **Required, not optional.** The field is required from the first commit. *(Rationale: an optional
   field permits the partial state the union forbids.)*
2. **Three exemption reasons, not more.** Additional reasons require a spec change, not an author's
   judgment. *(Rationale: an open-ended reason list re-creates the free-text defect.)*
3. **`route` + dotted path, not a function reference.** The manifest must stay importable by a lint
   that cannot import TypeScript (existing constraint, `lint-guard-manifest.js` parses source as text).
4. **Counters read at request time, never cached.** Node contract rule 5 (anti-decay).
5. **`effective-candidate` is the strongest verdict this surface can emit.** `effective` is reserved
   for a claim backed by a staged violation.
6. **Counter *semantics* are not standardised in this change — and that is closed, not deferred.**
   The manifest declares *where* the counters are, not what counts as a "look". `lookedMeans` binds
   each number to its own subject, and §"Verdicts are per-guard" forbids the cross-guard comparison
   that would REQUIRE a shared definition. **So the spec does not depend on normalisation to be
   correct** — it is a possible future refinement, not an outstanding obligation.
   If cross-guard comparison is ever wanted, that is a new spec with a new problem statement.
   <!-- tracked: closed-by-design — lookedMeans + the no-aggregation rule remove the dependency -->

7. **The sibling `NOT_A_GUARD.reason` field is in scope** (added round 4). The change is one schema
   applied to both lists in one file, not two changes. `CrashLoopPauser` hid in `NOT_A_GUARD`, so
   excluding it would have been fixing everywhere except where the motivating failure occurred.

**Cheap-to-change-after:** the derived-verdict vocabulary in §3 (rendering only, no durable state, no
external surface). **Not cheap:** the required field and the closed set — both are compile-time
contracts across 72 call sites, so they are settled here.

## Open questions

1. **Does `didAct` need to distinguish *acted* from *acted correctly*?** The design says no — that is
   decision point 4, and it belongs to the staged-violation harness. Flagged for reviewers who may
   disagree.
2. **Is the `legacyUntil` grandfather window the right length, and is it the right mechanism?** The
   measured scope is **153 entries across two lists**, which is why the design admits a bounded,
   build-enforced transitional state rather than an all-at-once migration. A reviewer may reasonably
   argue that any grandfather clause — even a dated, failing one — is the camel's nose. The
   counter-argument is that the alternative in practice is an optional field, which is strictly worse.
   **Recorded as the design's single genuine compromise, and the thing I most want challenged.**

## Control run (required before the PR)

Per Phase A's B-case rule, the control must be **two-sided**, and a catch alone proves nothing:

- **A-case (must FAIL):** a manifest entry with `observability` omitted → lint exits non-zero, naming
  the entry.
- **A2-case (must FAIL):** a `kind: 'counters'` entry declaring only `looked` and `didAct` → **compile
  error**, proving the partial state is unrepresentable.
- **A3-case (must FAIL):** a `kind: 'none'` entry with `reason: 'because reasons'` (18 chars — it would
  PASS the incumbent ≥12-char bar) → lint exits non-zero. **This is the regression test for the exact
  defect that hid `CrashLoopPauser`.**
- **A4-case (must FAIL):** a `kind: 'none'` entry with a valid closed-set reason and a resolving
  `evidenceRef` but **no `ratificationRef`** → lint exits non-zero. *(Regression test for the rounds-1-3
  finding: a well-formed symbol the author can type must never by itself buy an exemption.)*
- **A6-case (must FAIL):** a `kind: 'none'` entry whose `ratifiedUntil` is in the past → lint exits
  non-zero. *(Regression test for round 5: an unreviewed standing claim must not survive a build.)*
- **A5-case (must FAIL):** a `kind: 'counters'` entry with all three counters but no `lookedMeans` →
  lint exits non-zero.
- **B-case (must PASS):** the complete, correct 72-entry manifest → lint exits zero.
- **Control-of-the-control:** the lint must be shown running and consuming the modified file — an
  empty-index or mis-invoked lint exits zero and looks identical to a pass. *(Phase A lost hours to
  exactly this; the orphan-deferral test was invalidated by it.)*
