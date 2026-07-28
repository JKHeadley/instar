---
title: "Class-Closure Gate + Standards-Delta Escalator"
slug: "class-closure-gate"
author: "echo"
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
eli16-overview: "class-closure-gate.eli16.md"
status: "review-convergence (round-5 clean (codex VERIFIED CLEAN on both arms; gemini VERIFIED CLEAN r4; internal three-passage consistency sweep clean))"
tags: ["review-convergence"]
approved: true
approved-note: "Operator (Justin) approved the defect-class standards program 2026-07-03 in topic 29723; transcribed into the gate marker by Echo under the registered 24h autonomous build mandate (run run-mr58wczs-0b8103a2). Ships dark/report-only; operator retains veto."
origin: "INSTAR-Bench v2 defect-class review (docs/audits/ib2-defect-class-review-2026-07-02.md), Part 2 (the meta-question)"
operator-gate: "The gate + escalator are pipeline machinery — normal instar-dev pipeline, dark-first. Any STANDARD the escalator drafts ships ONLY with Justin's explicit sign-off (Agent Proposes, Operator Approves)."
review-convergence: "2026-07-03T19:48:22.690Z"
review-iterations: 5
review-completed-at: "2026-07-03T19:48:22.690Z"
review-report: "docs/specs/reports/class-closure-gate-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Spec — Class-Closure Gate + Standards-Delta Escalator (the meta-closure)

**Ships:** a required class-declaration field-set on the ship pipeline's committed review
artifacts + a validating lint (the gate); a deterministic recurrence trigger + a
pattern→proposal drafter (the escalator). Both dark-first, config-gated, repo-gated.

**Run boundary (Autonomy Principle 2):** the /instar-dev run's deliverable is the live gate
lint (report-only) + class registry + escalator machinery dark + DRAFTED text. Operator
sign-off on anything registry/constitution-bound is the run's endpoint.

## Problem statement

INSTAR-Bench v2 caught and fixed ten prompt defects. Each fix met the ship pipeline's
per-fix bar (reproduce, prove the fix, prove no regressions) — and NOTHING in the pipeline
asked the class question: *"what CLASS of defect is this an instance of, and what
structural change makes the whole class unrepresentable?"* The question fired only because
the operator asked it. That is willpower where the constitution's Root ("Structure beats
Willpower") demands structure — and the constitution even holds the meta-principle
(**Distrust Temporary Success: A Recurrence Is a Root Cause**) with no mechanical arm at
fix-time.

Second layer (verified against the live system): the failure-learning loop and the
framework-issues ledger already COLLECT instance records with buckets and dedup keys.
Collection exists; **forced generalization does not** — data flows in, no mechanism compels
a standards-delta out.

**Industry framing (round-1 external ask):** this is a CAPA (corrective and preventive
action) workflow — the review-record fields map to root cause (`defectClass`), corrective
action (the fix itself), preventive action (`closure`), and verification of effectiveness
(the periodic effectiveness review below). It lives in-repo rather than an external tracker
deliberately: the artifacts must be lintable in CI, git-replicated across machines, and
inside the same review chokepoint as the code they govern — an external tracker satisfies
none of those structurally.

**Terms (external readability):** *door* = the access path to a model (CLI wrapper vs clean
API); *route* = model + door; *ratchet* = a CI test pinning a baseline that may only
shrink; *callsite* = one LLM decision-point in the coverage registry. (Same glossary block
as the sibling specs.)

## Proposed design

### Piece 1 — the class-closure gate (fix-time chokepoint)

A fix for a defect found in an **agent-authored artifact** (LLM prompts, hooks, configs,
skills, standards text — initial scope; see Frontloaded Decisions) cannot CLOSE until its
committed review artifact declares:

- `defectClass`: an id from the class registry (below), or `novel` — and `novel` is not a
  free pass: it REQUIRES a new class-registry entry in the same change carrying the full
  semantics (at least one `includes`, one `excludes`, a `severity`, and a
  `nearestExistingClass` comparison — one line on why that nearest neighbor doesn't fit,
  which subsumes the bare `whyNotExisting`). A novel class enters as
  `status: "unconfirmed"` and raises ONE deduped attention item to the operator;
  **an unconfirmed class cannot satisfy `closure: guard`** (its fix carries `closure: gap`
  until the class is operator-confirmed) — so hyper-narrow self-serving classes buy
  nothing.
- `closure`: EITHER `guard` — the standard/test/lint that makes recurrence structurally
  refused or detected (nothing makes LLM-behavior recurrence literally impossible; the
  claim is bounded honestly), cited by path/symbol — OR `gap` — a tracked standards-gap
  item (id cited) when the class-level guard is genuinely out of the fix's scope. Gap items
  are evolution actions, which already carry `owner`, created/due dates, and re-surfacing
  cadence — the CAPA ownership fields exist there, not duplicated here.
- `guardEvidence` (required with `closure: guard`): the guard's ENFORCEMENT TYPE as graded
  by the Standards Enforcement Coverage audit's grader (`ratchet` / `gate` / `lint`), plus
  one line on *how this guard would have caught THIS defect*. Existence-on-disk is not
  enough (a dark, dry-run, or spec-only artifact guards nothing — G3): **a citation that
  does not resolve to a live enforcing guard automatically downgrades the declaration to
  `closure: gap`.** Wiring, stated (the grading must not ride a dark runtime dependency):
  the lint invokes the conformance audit's deterministic grader **as a library over the
  repo checkout** — never the agent-runtime route (which ships dark and 503s). Grader
  unavailable or erroring ⇒ the declaration downgrades to `gap` (fail-closed), stated
  normatively.
- `gap` items are NOT fire-and-forget (Close the Loop): a gap is filed as an evolution
  action (riding the existing re-surfacing cadence), and an OPEN gap item COUNTS AS
  ESCALATION EVIDENCE (below) — 2 instances + 1 open gap escalates. A gap open past a
  max age (default 45 days) escalates once on its own.

**Host (concrete, verified — resolves round-1 F9):** the "review record" is not a new
artifact. The gate's fields live as (a) a structured JSON block in the instar-dev
**decision-audit entry** (the machine-readable host the lint validates) and (b) a mirrored
required section in the **side-effects artifact** (`upgrades/side-effects/<slug>.md`,
extending the existing template — the human-readable mirror). Field order is free; the lint
validates presence and shape, not ordering. The same block is where the program's A/B
mechanical arm lives: any prompt-touching fix embeds its A/B verdict summary (run id,
routes, fixed/regressed counts) in the same structured block, lintable.

Mechanically: the lint rides the PR-gate workflow family (the `decision-audit-gate.yml`
precedent), scoped to diffs touching agent-authored artifacts. Cost per fix: one paragraph.
Effect: an instance fix can never again silently absorb a class — it either cites the live
guard that ends the class or creates the tracked demand for one.

**Gate self-wedge exemption (bounded, gate-source-ONLY):** the exemption applies only when
the diff touches EXCLUSIVELY the gate's own source files — any other agent-authored
artifact in the same diff still requires its declaration (a mixed PR cannot ride the
exemption), the exemption is logged, and the cap counts per-PR (the
guard-bypass-carries-its-own-cap rule). A broken gate can never block its own repair; its
repair can never smuggle undeclared fixes.

### The class registry

`docs/defect-classes.json` — seeded with the four measured classes, each carrying real
semantics (not just ids): `id`, `description`, `includes` / `excludes` criteria,
`canonicalExamples`, `status` (`confirmed` / `unconfirmed`), `closureStandard` (nullable)
**plus the closure standard's enforcement status as last graded**, and the escalation state
(`instanceCount`, `escalatedAt`, `proposalId`, `evidenceCountAtLastAck`) — keeping
escalation bookkeeping IN the registry makes escalator ticks idempotent and O(new records),
and implements the backfill mitigation for free:

```json
{
  "classes": [
    { "id": "prompt-parser-contract-drift", "status": "confirmed",
      "closureStandard": "prompt-parser-contract-standard", "escalatedAt": "seeded-closed" },
    { "id": "injection-credulity", "status": "confirmed",
      "closureStandard": "authority-clause-standard", "escalatedAt": "seeded-closed" },
    { "id": "claim-vs-evidence", "status": "confirmed",
      "closureStandard": "evidence-bar-judge-extension", "escalatedAt": "seeded-closed" },
    { "id": "durable-output-secrets", "status": "confirmed",
      "closureStandard": "durable-output-hygiene-standard", "escalatedAt": "seeded-closed" }
  ]
}
```

(**`seeded-closed`, defined precisely:** a seed enters as escalated-and-acked with
`evidenceCountAtLastAck` initialized to its seed-time `instanceCount` — so ONLY historical
backfill is suppressed. A post-seed declaration that grows a seeded class past that
baseline fires the deterministic re-raise/reopen path at lint time, exactly like any other
class — the four measured classes are the LIKELIEST to recur, and their recurrence must
never wait on the dark drafting arm. Recurrence-despite-closureStandard rides this same
deterministic path; the periodic effectiveness pass is backstop only.)

### Piece 2 — the standards-delta escalator (deterministic trigger, drafted proposal)

**Trigger (deterministic, always-on with the gate — resolves round-1 F10):** the recurrence
count does NOT live in the fleet-dark failure-learning loop — and it is DERIVED, never
hand-maintained (resolves the round-2 bookkeeping cluster: per-PR count edits would
merge-conflict between concurrent fixes, silently undercount on clean merges, and drag
every routine fix through a protected file). The committed `defectClass` declarations ARE
the count: the gate lint recomputes each class's `instanceCount` by scanning the
**decision-audit entries ONLY** — the single machine-readable counting host (round-3
material finding: scanning both mirrored hosts would double-count every fix — 2 real
instances reading as 4 and falsely crossing the ≥3 threshold — and duplication would let an
author inflate evidence; the side-effects artifact's mirrored section is DISPLAY-ONLY for
human review, and the lint's mirror-consistency check asserts the two hosts AGREE, it never
adds them). Each decision-audit entry carries the fix's PR number as its natural dedup key
— two entries citing the same PR + class count once. The count is conflict-free,
self-healing, and validated rather than written; the registry's stored field is a CACHE the
lint checks and the escalator's pass refreshes. The lint VALIDATES, the periodic pass
MUTATES — no CI job ever edits source in a contributor's PR. When derived declarations show
the SAME class ≥N times (default 3) across ≥2 distinct components — or ≥2 instances plus an
open gap item, or ONE confirmed instance of a class tagged `severity: critical`, **or ≥K
times (default 5) within a SINGLE component** (round-3 material finding: without this arm, a
class recurring 10× inside one component at normal severity never deterministically
escalates — the component-spread requirement exists to distinguish a systemic pattern from
one noisy component, so the single-component arm uses a higher K rather than no arm at all)
— the threshold is crossed deterministically at lint time.

**Severity is not optional (resolves round-2):** every class entry carries `severity`
(`critical` = security/privacy/data-loss ⇒ escalates at 1 confirmed instance; `normal`
⇒ the ≥3-across-≥2-components rule OR the ≥K=5-single-component arm — both round-3 arms
apply; `normal` is the only tier where they are operative, since `critical` escalates at 1).
Operator confirmation of a novel class explicitly confirms its severity;
the effectiveness review audits severity assignments. Seeds: `durable-output-secrets` and
`injection-credulity` are `critical`; the other two `normal`.

**Drafting (dark-first; deterministic skeleton + LLM narrative only):** on a crossed
threshold, the escalator produces a **standards-delta proposal** at the deterministic path
`docs/proposals/<classId>.md` (repo-gated, like release-readiness: no-op on non-maintainer
installs; a CI check asserts at most one open proposal per class) — plus ONE
attention-queue item with the stable id `escalator:<classId>` (pool-coalesced via P17, so
multi-machine raises collapse; novel-class confirmation items use the same
`class-registry:<classId>` stable-id shape). The proposal's skeleton (class, evidence list,
counts, cited fixes) is TEMPLATE-FILLED deterministically; only the narrative section is
LLM-drafted, under the constraints below. The proposal is a draft, never an adoption:
**Agent Proposes, Operator Approves** is preserved by construction (the escalator has no
write path to `STANDARDS-REGISTRY.md`). The escalator's periodic pass runs Tier-1
supervised (per the LLM-Supervised Execution standard) and is ALSO the named write path for
ack bookkeeping: it reads the attention store on the maintainer machine and commits
`evidenceCountAtLastAck` back to the registry cache — a runtime ack thereby reaches git
through one audited, repo-gated writer.

**Multi-machine posture (declared):** class registry, review artifacts, and proposals are
git-replicated (the repo IS the replication medium); dedup is REPO STATE ("does an open
proposal file for this class exist?"), never machine-local JSONL — so two machines cannot
double-file. No file-local escalator state exists (nothing for BackupManager to consider).

**Dedup that cannot become a suppressor (resolves round-1):** re-triggering updates the
existing draft's evidence list — AND the attention item re-raises when the class's evidence
count grows past `evidenceCountAtLastAck` (the release-readiness age/evidence-escalation
shape). One stale acked proposal can no longer park a class forever.

**The escalator drafter is subject to its sibling standards (self-application):** the
drafting callsite is flagged `untrustedInput` + `durableOutput` in the shared metadata
record (its evidence inputs derive from transcripts/tool output; its output is a committed
file), carries the authority + durable-output clauses, runs the shared scrub before write,
and quotes evidence excerpts in neutralized/delimited form. The meta-machinery must not
reintroduce Classes 2 and 4.

**Effectiveness review (softening "why this converges" — resolves round-1):** convergence
is a tendency, not a theorem — bad classes, weak guards, and stale gaps can accumulate. The
escalator's periodic pass therefore also audits: recurrence-despite-closureStandard
(REOPENS the class and flags the standard), classification drift (spot-check of recent
`defectClass` declarations against class semantics), taxonomy health (overlapping/
ambiguous classes proposed for merge), open-gap ages, and the shared scrub pattern-list
staleness (per `durable-output-hygiene-standard.md`). Classes shrink only while guards
actually hold; the review is what notices when they don't.

## Program-shared machinery (defined once here; binding on all five specs)

1. **ONE per-callsite metadata record.** All program flags extend the existing
   `src/data/llmBenchCoverage.ts` record (per-COMPONENT granularity, matching the registry;
   components with two surfaces carry two entries):
   `{ task, contract?, untrustedInput!, judgesClaims!, durableOutput! }` — `!` fields are
   required-explicit with argued-false pinned shrink-only. ONE consolidated axis-requirements
   ratchet test derives every required axis from the flags; the per-spec pending sets are
   fields of a single pinned baseline. (Kills the four-independent-ratchets drift the
   round-1 scalability review flagged.)
2. **Batteries readable by CI (frontloaded decision).** The task batteries are committed to
   the canonical repo under their existing quarantine path (payload files referenced by
   path, excluded from cartographer/KB sweeps, placeholder constants allowlisted in the
   leak-detector). The consolidated ratchet reads battery JSON directly — one source, no
   axis-manifest copy to drift. NAMED FALLBACK if maintainers refuse payload files on main:
   a distilled per-task axis manifest in `src/data/` carrying each battery's sha256, plus a
   benching-agent conformance artifact asserting manifest↔battery parity; the ratchet then
   asserts against the manifest with the caveat recorded in the standard text.
3. **The A/B mechanical arm.** "Ships only through A/B" is enforceable only if CI can see
   the verdict: every prompt-touching fix embeds its A/B verdict summary in the gate's
   structured review block (host above), and the A/B harness runs the prompt-fidelity
   precondition (bench template diffed against the real rendered production prompt — the
   prompt-parser render functions are the diff source) before any verdict counts.
4. **Protected paths — anchored on the exemption chokepoints, not the whole registry**
   (resolves the round-2 composition finding: protecting the coverage map wholesale would
   route EVERY routine fix and every new-callsite PR to the operator, reverting the
   auto-merge machinery for the dominant PR class). The protected set is:
   `docs/defect-classes.json` (class SEMANTICS — routine fixes never touch it now that
   counts are derived), `src/core/promptClauses.ts`, the chokepoint inventory, and the
   **pinned-baseline ratchet test files**. That last anchor is sufficient by construction:
   every exemption, argued-false flag, and pending-set edit MUST touch a pinned baseline to
   pass CI — so all of them route to the operator — while an additive, fully-conforming new
   callsite entry (flags true, axes present) touches no baseline and keeps auto-merge.
   No self-service exemption can auto-merge; no routine fix loses throughput.
5. **X1 exemption shape.** An exemption anywhere in the program is a registry/manifest
   entry with `reason` + `owner`, landed via normal PR review.
6. **X2 A/B bound.** Any per-component prompt migration is bounded at 2 failed A/B attempts
   per run; the incumbent stands and a tracked gap item is filed — a named legitimate
   terminal state.

## Decision points touched

The gate adds a build-time refusal (missing/invalid class declaration = red PR-gate lint)
on the instar-dev ship path — CI-only, no runtime gates. The escalator adds an
attention-queue producer (bounded, deduped-with-re-raise, pool-coalesced). No runtime
allow/deny changes.

## Config & posture

- Config: `prGate.classClosure` = `{ enabled, dryRun, escalatorDrafting }` — the existing
  PR-gate family, NOT a new `pipeline.*` family (`escalatorDrafting` is the dark-staged LLM
  arm's own key; the deterministic trigger rides `enabled`). Repo-gated (no-op/503 on
  installs without the instar repo, the release-readiness precedent), so Migration Parity
  owes the fleet nothing for maintainer-only machinery. Build-time re-grounding note: the
  build verifies its hosts (`src/data/llmBenchCoverage.ts`, the decision-audit workflow,
  `upgrades/side-effects/`) exist on the CANONICAL branch it targets — they are verified on
  main today but absent from some serving branches.
- Guard posture: the gate and the escalator trigger register in `guardManifest` so `/guards`
  reports them; once the registry text names the gate as an enforcement arm it is marked
  `loadBearing` (a dark gate visibly classifies as a load-bearing gap instead of silently
  guarding nothing).

## Frontloaded Decisions

1. **Initial scope boundary** (was Open Q1): agent-authored artifacts only (prompts, hooks,
   configs, skills, standards text). Expansion to critical-path product defects is an
   explicit post-run decision informed by the report-only friction telemetry.
2. **N and the window** (was Open Q2): N=3 across ≥2 components OR K=5 within one component
   (round-3 arm), windowless (defect classes don't expire), config-tunable; severity
   override — critical classes escalate at 1; the four seeds enter
   `escalatedAt: "seeded-closed"` so backfill can't re-fire. Counting host: decision-audit
   entries only, deduped by PR (round-3; the side-effects mirror is display-only).
3. **Who classifies** (was Open Q3): the fix author declares; the lint validates form; the
   escalator's periodic pass audits classification accuracy by spot-check (drift is a
   finding, not a blocker). During dryRun, classification ACCURACY is measured alongside
   friction — the gate flips to enforcing only if the declarations are actually reliable.
4. **Record shape** (was Open Q4): decision-audit structured block + side-effects mirrored
   section; presence/shape validated, ordering free.
5. **Enforcing flip criterion:** report-only has covered ≥10 agent-authored-artifact fixes
   or 14 days, with the class block populated on 100% of them and zero pipeline breakage.
   **The criterion cannot become a delay-forever lever held by the gated party:**
   report-only older than 30 days with <100% population raises ONE attention item carrying
   the population/accuracy stats — the OPERATOR decides the flip on that evidence — and
   fixes shipped without declarations during report-only are retro-filed as gap items, so
   under-populating buys nothing.
6. **Exemption shape / A/B bound:** X1/X2 (program-shared machinery above).

## Rollout

1. Class registry + review-block fields + gate lint land; lint report-only (logs missing
   declarations, blocks nothing) — measures friction AND classification accuracy honestly
   first. Protected-path additions land with it.
2. Lint flips to enforcing for agent-authored-artifact fixes per the flip criterion
   (`prGate.classClosure.enabled` + `dryRun`).
3. Escalator drafting lands dark (repo-gated; the deterministic trigger is part of the gate
   lint and lives from step 1; only the LLM drafting arm is staged).

## Open questions

*(none)*
