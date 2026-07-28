---
title: "Census Tracker Refs Are Verifiable — a machine-local id in shipped source can never resolve"
slug: "census-tracker-ref-kinds"
author: "echo"
status: "draft"
created: 2026-07-25
parent-principle: "Verify the State, Not Its Symbol"
sibling-principles: "Observation Needs Structure; Close the Loop; No Silent Degradation to Brittle Fallback; An Instar Agent Is Always a Multi-Machine Entity; Testing Integrity; Structure beats Willpower"
lessons-engaged: "the 2026-07-23 pending-tracker false-alarm fix (split `unverifiable` from `dead` — the correct FIRST half of this arc); llm-decision-quality-meter §5.6 (the retrofit backlog these trackers point at); tone-gate-advisory-migration 2026-07-25 (the sibling case: a metric that reads clean while being structurally incapable of meaning anything)"
origin: "Autonomous run 2026-07-25, topic 33368 — task 2. Surfaced by GET /decision-quality reporting pendingRefUnverifiable: 49 on this machine, indefinitely."
eli16-overview: "census-tracker-ref-kinds.eli16.md"
review-convergence: "2026-07-25T09:14:34.440Z"
review-iterations: 2
review-completed-at: "2026-07-25T09:14:34.440Z"
review-report: "docs/specs/reports/census-tracker-ref-kinds-convergence.md"
approved: true
approved-by: "Autonomous run 2026-07-25, topic 33368 — task 2 of the operator-authored run plan ('Census dead-reference fix. Resolve the dangling ACT-1193 reference blocking all 49 pending decision points'), under the run's standing instruction that decisions are reversible and dark-shipped: 'make the call, state it, keep going.'"
approval-scope-note: "This is NOT a quoted per-change approval — the run plan authorized the TASK, and I chose the design. Two deviations from the literal instruction are on the record rather than assumed. (1) The task says fix the reference 'so pendingRefUnverifiable shrinks'; shrinking that number was achievable in a minute by swapping in a locally-live ACT id, which would have read clean here and stayed broken everywhere else. I built the verifiable version instead, and the count drops as a consequence — argued in section 1 under 'What this spec is NOT'. (2) The first design was INVERTED mid-flight after external review proved it would have been worse than shipping nothing; both the flaw and the correction were reported to Justin in topic 33368 on 2026-07-25 before the build continued, not disclosed after the fact. Reversible: revert restores today's behaviour, and no flag or durable state is introduced."
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Census Tracker Refs Are Verifiable

## 1. The problem

`GET /decision-quality` reports census debt so the provenance-enrollment backlog
cannot rot silently. On this machine it reports:

    censusDebt: { wired: 7, pending: 49, exempt: 6, pendingRefUnverifiable: 49 }

**All 49 pending decision points are unverifiable, and always will be.** Every
one carries `status: 'pending:ACT-1193'` — an evolution-action id — and
`PROVENANCE_COVERAGE` is a SHIPPED SOURCE CONSTANT, byte-identical on every
install, while the evolution action queue is **machine-local and unreplicated**.

A machine that never minted an id that high has not deleted the tracker; it has
never seen it. The 2026-07-23 fix correctly recognised this and split
`unverifiable` from `dead` so the check stopped reporting a deletion that never
happened. That was the right first half.

This is the second half. Not-false-alarming is not the same as verifying. The
tracker still resolves on exactly one machine in the fleet — the one that minted
`ACT-1193` — so for every other install the debt signal is permanently
uninformative. A number that can only ever say "I don't know" is not a check.

**What this spec is NOT.** The task as written says "resolve the dangling
reference so `pendingRefUnverifiable` shrinks." Swapping in a locally-live ACT id
would shrink it to zero on this machine and change nothing anywhere else — the
metric would look fixed and remain broken. That is gaming, and it is explicitly
rejected. The goal is a tracker that is **verifiable**, after which the count
drops as a consequence.

## 2. Design

### 2.1 Tracker refs are typed by KIND

`ACT-1193` is not a bad id; it is the wrong KIND of id for the job. A
machine-local bookkeeping handle was written into a fleet-wide constant.

Two ref kinds, distinguished by prefix:

| kind | example | how it is adjudicated |
|---|---|---|
| `ACT-<n>` | `ACT-1193` | unchanged — the existing queue + high-water logic |
| `backlog:<key>` | `backlog:decision-quality-enrolment` | exact-match lookup in `BACKLOG_TRACKERS`, a shipped source constant in `src/data/provenanceCoverage.ts` |

`parseTrackerRef(ref)` returns a discriminated result; `adjudicatePendingTracker`
branches on it. An unrecognised shape keeps today's strict `dead` reading — a
malformed tracker must still surface rather than hide in a new bucket.

**Frontloaded decision 1 — the anchor is a source CONSTANT, not a document.**
The intuitive anchor is a spec file (`spec:llm-decision-quality-meter#5.6`),
checked with `fs.existsSync`. It is wrong, and the reason is worth pinning
because it inverts the whole change: **`docs/` is excluded from the published
package** — `.npmignore` line 8, and absent from `package.json` `files[]`. A
doc-path existence check therefore resolves FALSE on every fleet install,
converting 49 honest `unverifiable` entries into 49 fleet-wide false `dead`
ones. That is strictly worse than the status quo and re-runs the exact false
alarm the 2026-07-23 fix removed.

`src/data/` **is** published and compiles into `dist/`, so a constant declared
there is byte-identical on every install *by construction* — no filesystem, no
packaging assumption, and no sub-document anchor that can drift when a heading
is renamed. `tests/unit/census-tracker-ref-kinds.test.ts` asserts both halves of
that packaging fact directly against `package.json`, so the rejected design
cannot be reintroduced silently.

*(Credit where due: external cross-model review caught this. The first draft of
this spec shipped the doc-path design.)*

**Frontloaded decision 2 — the adjudicator is PURE, with no injected predicate.**
Because the registry is a source constant, the function imports it and needs no
filesystem and no `specExists`-style seam. That is strictly simpler than the
rejected design *and* more verifiable: `unverifiable` is unreachable for the
`backlog:` kind by construction, which the unit tier asserts.

**Frontloaded decision 3 — `liveActs` becomes nullable.** A `backlog:` ref needs
no evolution queue, but the route previously skipped adjudication entirely when
`action-queue.json` was absent. Left alone, every fleet-stable ref would be
silently *uncounted* on exactly the installs the kind exists to serve. The null
case moves into the adjudicator: `backlog:` resolves normally, and an `ACT-<n>`
ref with no readable queue reports `unverifiable` — never `dead`.

**Frontloaded decision 4 — this is not a new invention.** `ProvenanceStatus`
already carries `exempt:operator-ratified:<ref>`, documented as "a resolvable ref
(PR / standards-registry anchor), also ratchet-validated." The resolvable-ref
convention exists in this exact file; the pending kind simply never adopted it.

### 2.2 The format ratchet moves with it

The type doc states pending refs are "format-validated (`^ACT-\d+$`) and
baseline-pinned by the ratchet." That ratchet is correct today and would
correctly reject a `backlog:` ref, so it is extended in the same change —
otherwise the build fails for the right reason at the wrong time.

**Frontloaded decision 5 — the ratchet must still reject garbage.** Widening it
to "anything" would remove the guard that makes a typo visible. It accepts
exactly the two kinds (`^ACT-\d+$ | ^backlog:[a-z0-9][a-z0-9-]*$`) and nothing
else — and it additionally resolves every `backlog:` ref against the registry at
CI time, so a dangling key dies in the build rather than surfacing later as a
runtime `dead` verdict.

### 2.3 What actually shrinks the backlog

Repointing refs makes the debt signal legible. It does not enrol anything. The
second half of the task — enrolling the highest-volume unenrolled decision points
so they genuinely record — is where the count drops for real, and it is
sequenced after this because enrolment against an unverifiable tracker is
building on sand.

### 2.4 Alternatives considered

Recorded because the chosen anchor is not the only stable one, and a reader
should not have to infer why it wins here.

| alternative | why not |
|---|---|
| **GitHub issue / PR id** (`gh:1618`) | Genuinely fleet-stable, and the honest runner-up. Rejected because resolving it needs network + auth to a repo most installs cannot read: a fleet agent would get `unverifiable` for a *different* reason, trading a local-state dependency for a network-and-permissions one. A check that fails closed on an outbound call is worse than one that cannot fail at all. |
| **Commit / tree anchor** | Immutable and offline-checkable, but it names a point in history, not an obligation. It answers "did this commit exist?", never "is this work still tracked?". |
| **A separate machine-readable manifest shipped in the package** | Works, and is what the registry effectively is — minus a second file, a second format, and a second thing that can drift from the entries it describes. Co-locating the registry with the entries in one source file is the same idea with fewer seams. |
| **A replicated action log** (the evolution queue, made cross-machine) | The "right" long-term fix for machine-local trackers generally, and out of scope here: it changes a durable multi-machine store to repair a read-surface counter. Deliberately not attempted — this spec stops *depending* on that locality rather than changing it. |

### 2.5 Two review findings adjudicated, not adopted

Both raised by external cross-model review (2026-07-25, round 2) and both
reasonable from outside the code. Recorded with the evidence that closes them.

**"A mixed-version fleet breaks this — an old adjudicator reads `backlog:` as
unknown and reports `dead`."** Not reachable. The refs and the parser are the
*same shipped artifact*: `PROVENANCE_COVERAGE` (which holds the refs) and
`adjudicatePendingTracker` (which parses them) both compile into `dist/` from
one package version. An install therefore has old refs with an old parser, or
new refs with a new parser — never a mix. The one path that could cross machines
is the pool merge, and `censusDebt` is built at a single local callsite and is
not among the pool-merged fields, so a peer's raw ref never reaches another
machine's adjudicator. (Verified, not assumed.)

**"`dead` for a malformed ref is semantically muddy — add an `invalid`
verdict."** Correct as a matter of vocabulary, declined on reachability. The
ratchet now format-validates every pending ref *and* resolves every `backlog:`
key against the registry at CI time, so a malformed ref cannot reach a release;
an `invalid` runtime verdict would be dead code guarding an impossible state.
It would also widen the two-bucket contract the 2026-07-23 fix established
(`dead` vs `unverifiable`) for no operational gain. The diagnosability concern
is real but lands at build time, where the failure message names the entry.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `adjudicatePendingTracker` verdict (alive / dead / unverifiable) | `invariant` | A closed, enumerable domain: a ref either parses to a known kind and resolves, or it does not. No competing signals, no context to weigh — the failure mode this replaces was a *missing branch*, not a judgment call. |
| Tracker-ref format validation (the ratchet) | `invariant` | A closed-world format check over a two-member enum at a dev-process chokepoint — the documented Signal-vs-Authority exemption class. It decides nothing about meaning. |

## Multi-machine posture

- **Tracker refs in `PROVENANCE_COVERAGE` — unified.** That is the entire point:
  a `backlog:` ref resolves against a shipped source constant, so every machine
  answers identically. The defect being fixed is precisely that today's ref is
  machine-local while the constant carrying it is fleet-wide.
- **`BACKLOG_TRACKERS` — unified.** A source constant in `src/data/`, which is
  published (`package.json` `files[]`) and compiled into `dist/`. Uniformity is
  structural, not conventional: there is no per-machine copy to diverge.
- **`adjudicatePendingTracker` — unified.** A pure function over that constant.
  It reads machine-local state ONLY for the `ACT-<n>` kind, which is
  machine-local by design and already carries the high-water guard.
- **The evolution-action queue — machine-local BY DESIGN** —
  `machine-local-justification: operator-ratified-exception`. Inherited, not
  introduced: the queue's locality is pre-existing and out of scope here. The
  ratified artifact is the 2026-07-23 high-water adjudication already in
  `src/server/routes.ts`, which exists specifically to keep that locality from
  producing false deletions. This spec stops *depending* on that locality for
  fleet-wide trackers rather than trying to change it.

## Open questions

*(none)*

> Whether the remaining `ACT-` kind should eventually be retired entirely is a
> real question, but not one that blocks this: some trackers legitimately are
> machine-local work items, and the kind distinction is what lets both coexist
> honestly.

## Maturation plan

- **test-agent-live:** n/a — a read-surface correctness fix with no agent-class staging surface.
- **dev-agent-live:** this ship. The adjudicator change is always-on; it is a correctness fix to an observe-only debt counter, not a gated capability.
- **dark-window:** none — the change cannot loosen a guard. It converts "permanently unknown" into a real verdict, and an unrecognised ref still reads `dead` exactly as today.
- **graduation criterion:** THREE conditions, not one. On a machine that never
  minted `ACT-1193`, `GET /decision-quality` reports (a) `pendingRefUnverifiable`
  EMPTY, (b) `pendingRefDead` EMPTY, and (c) `pending` unchanged at 49. All three
  are required together. (a) alone is gameable in the wrong direction — a
  malformed or unregistered ref moves to `dead`, not `unverifiable`, so the
  headline number can "improve" by reclassifying uncertainty into failure. (c)
  is what stops the other gaming direction: quietly shrinking the backlog. All
  three are asserted in the E2E tier on the real boot path, and the unit tier
  additionally pins the exact ref DISTRIBUTION (all 49 on one deliberate key —
  aggregate counts can look healthy while refs quietly drift apart) and the
  absence of orphaned registry keys.
- **fleet:** ships with the release; no flag, because there is no looser state to roll back to.

## Testing

- **Tier 1** (`tests/unit/census-tracker-ref-kinds.test.ts`, 21 cases) —
  `parseTrackerRef` over both kinds and a garbage corpus (including the rejected
  `spec:` shape, which must parse as `unknown`); `adjudicatePendingTracker` on
  both sides of every branch, including an unregistered key (`dead` — a removed
  registry entry IS a real deletion) and the null-queue case for both kinds; the
  **packaging invariant** asserted directly against `package.json` (`src/data`
  ships, `docs/` does not) so the rejected design cannot return silently;
  prototype-key safety on the registry lookup (`constructor` / `__proto__` must
  not resolve); and every pending census entry resolving on a queue-less install.
- **Tier 2** (`tests/integration/census-tracker-ref-kinds-routes.test.ts`) —
  `GET /decision-quality` through the real Express routes + authMiddleware
  returns EMPTY `pendingRefUnverifiable` and `pendingRefDead` with `pending`
  unchanged, on both a no-queue install and a populated queue that never saw
  `ACT-1193`; auth still required.
- **Tier 3** (`tests/e2e/decision-quality-alive.test.ts`) — the real `AgentServer`
  boot asserts all three graduation conditions on the production init path,
  which runs against a fresh stateDir with no evolution queue — i.e. exactly the
  fleet install the old ref could not answer for.

## Rollback

Revert. There is no flag because there is no weakened state to return to: the
change adds a ref kind and a branch.

**Stated honestly, because the first draft got this wrong:** *before* a revert, a
`backlog:` ref pointing at a key that is not in the registry reports **`dead`**,
not `unverifiable` — that is the design, since a shipped registry's silence is a
fact on every install rather than a local gap. So the failure mode of a bad ref
is a loud false deletion, not a quiet unknown. Two things bound it: CI resolves
every `backlog:` ref against the registry, so a dangling key cannot reach a
release; and reverting restores today's `unverifiable` reading. The operational
response to a `dead` verdict is to check the registry key, not to assume the
tracked work vanished.
