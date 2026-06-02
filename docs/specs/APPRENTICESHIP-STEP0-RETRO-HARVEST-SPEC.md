---
title: "Apprenticeship Step 0 — Retro-Harvest (the prior-instance review prerequisite)"
status: draft
tier: 2
parent: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
step: 0
approved: false
approver: justin
author: Echo
date: 2026-06-01
topic: 13435
slug: APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC
companion: APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.eli16.md
eli16-overview: APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.eli16.md
builds_on:
  - APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
  - FRAMEWORK-ONBOARDING-MENTOR-SPEC.md
  - framework-issue-observe-write-path.md
review-convergence: "2026-06-02T03:11:49.994Z"
review-iterations: 3
review-completed-at: "2026-06-02T03:11:49.994Z"
review-report: "docs/specs/reports/APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Apprenticeship Step 0 — Retro-Harvest

**Parent:** `APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md` (Tier-3 umbrella, approved 2026-06-02)
**Step:** 0 of 5 — the **prerequisite** that must complete before any apprenticeship/mentorship
instance begins.
**Author:** Echo · **Topic:** 13435 · **Companion ELI16:**
`APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.eli16.md`

> **Convergence note (round 1).** Three independent reviewers, grounded in the live ledger
> code, found that the original draft's "seed meta-lessons into `GET /framework-issues/playbook`"
> path **cannot work**: `recordObservation` is born at `playbook_status='none'`, the playbook
> query returns only `candidate`/`extracted`, auto-promotion fires only on a terminal
> `fixed`/`wont-fix` in a *generalizable bug bucket*, a process meta-lesson fits none of those
> buckets, and **Echo cannot self-promote its own lessons** (the ledger throws) — plus the
> populate path is a known open bug (task #50). This version corrects that false floor (§5–6),
> adds a redaction invariant (§7), bounds the corpus (§8), demotes the validator from "done-gate"
> to *signal* with an LLM fidelity review as the *authority* per **Signal vs Authority / The Body
> and the Mind** (§9), and schematizes `programNeeds` (§10). Full changelog: §15.

---

## 1. Problem

Justin's hard prerequisite (2026-06-01): *"A pre-requisite to starting this should be to
review ALL of the notes/learnings from the previous mentorship/apprenticeship to extract
lessons, meta-lessons, and insights that improve our mentorship and apprenticeship processes
themselves."*

We have a large, scattered corpus of learnings from the Echo→Codey mentorship — the
framework-issue ledger, the onboarding playbook, Echo's memory files, the topic-13435 /
topic-458 thread history, and the shipped mentor PRs. Today that corpus is **not distilled**:
lessons live where they were captured, the *generalizable* ones aren't separated from the
codex-specific ones, and **nothing about the mentorship *process itself* has been harvested**.
If the Codey→Gemini instance starts from that raw scatter, it repeats avoidable mistakes and
the apprenticeship learns nothing from the mentorship that produced it.

This step produces the **retro-harvest**: a structured distillation of the prior instance into
**lessons, meta-lessons, and process insights**, written to a durable **harvest artifact** that
is *itself* the authoritative onboarding-knowledge store for the next instance, plus an explicit
**"what the program needs" requirements list** that becomes the input to Step 1 (the minimal
program scaffold).

This is the **first run of the retro-harvest**; the *gate* that will **require** a valid harvest
before every future instance is wired in Step 1 (§13 — boundary rationale). Step 0 produces the
artifact, the repeatable procedure, and the validator that gate will call.

## 2. Goals / Non-goals

**Goals**
1. Define a **repeatable retro-harvest procedure** + a **harvest-artifact schema** — so every
   future instance-boundary runs the same review, not a one-off (Structure > Willpower).
2. **Run it once** against the Echo→Codey mentorship to produce the first real harvest artifact.
3. Make the **harvest artifact the authoritative meta-lesson + process-insight store** for the
   next instance (it does *not* depend on the bug-shaped framework-issue playbook to carry
   process wisdom — see §5).
4. Emit a **schematized "what the program needs" requirements list** (§10) — concrete,
   prioritized, evidence-pointed inputs to Step 1.

**Non-goals**
- Building the retro-*gate* (the enforcement that blocks an instance start without a harvest) —
  that is Step 1 (§13).
- Changing the framework-issue ledger / playbook *schema*. Step 0 reuses the ledger as-is for
  genuine bug-class lessons only, and does **not** force process meta-lessons into it (§5).
- Fixing the playbook-populate bug (task #50). Step 0 must not *depend* on it; where seeding is
  attempted it is candidate-only and explicitly best-effort (§5).
- Onboarding Gemini or building any runtime adapter — Steps 2–4.
- A fully-automated harvester. Step 0's harvest is **LLM-performed synthesis following a defined
  procedure under an LLM fidelity review** (§9), not an autonomous extraction pipeline.

## 3. The corpus (sources to mine)

The procedure mines, in priority order, **bounded** (§8):

1. **Framework-issue ledger** — `GET /framework-issues?framework=codex-cli` (+ all buckets):
   the bucket-tagged record of every issue found mentoring Codey.
2. **Onboarding playbook** — `GET /framework-issues/playbook` current state (what's already
   generalized, to avoid re-deriving it).
3. **Echo's memory files** — the codex/Codey/mentorship topic files.
4. **Thread history** — topics 13435 + 458, **delta-scoped** by default (§8): since the prior
   harvest's `harvestedAt`, with chunk-and-reduce for large windows.
5. **Shipped mentor PRs + specs** — what the mentorship *built*, and why.

Per harvest the procedure records, per source, **coverage extent** (not just presence) so a
partial harvest is visibly partial (§8).

## 4. The taxonomy (how findings are categorized)

Every harvested item carries a **primary** kind and an optional **secondary** kind (mirroring the
ledger's `bucket`/`bucketPrimary` — items are often dual-natured; forcing one bin loses signal):

| Kind | Definition | Example (from Echo→Codey) |
|---|---|---|
| **Lesson** | Specific, often framework-bound; actionable for *this* framework. | "Codex stop-hook chain emits invalid JSON on normal completion." |
| **Meta-lesson** | Generalizable across frameworks; a pattern that will recur for the next mentee. | "The real work of onboarding a framework IS the runtime adapter, not the agent-facing layer." |
| **Process-insight** | About the mentorship/apprenticeship *process itself*. | "The dual-vantage loop (drive as user → read as developer) finds root causes a parity project misses." |

**Anti-skew rule (adversarial finding):** *meta-lesson is the NARROWEST bin*, not the default.
The burden of proof is on generalization — an item is a meta-lesson only if it demonstrably
recurs cross-framework. The codex full-parity history is the cautionary example: most "lessons"
there were codex-specific, not meta. The harvester defaults to **lesson** unless cross-framework
recurrence is shown.

**Where each kind lives:**
- **Lessons** — already in the ledger; the harvest *references* them (by id), does not duplicate.
- **Meta-lessons + Process-insights** — authoritative in the **harvest artifact** (§5). This is
  the onboarding knowledge the next instance reads.

## 5. Storage model — the harvest artifact is authoritative (the corrected seed design)

The original draft assumed meta-lessons could be seeded into `GET /framework-issues/playbook`.
The ledger code makes that false (see the convergence note). The corrected model:

**(a) The framework-issue ledger stays bug-shaped.** It holds *lessons* (framework-specific
bugs/gaps) in its three buckets. The harvest references them; it does not re-home them.

**(b) The harvest artifact is the authoritative store for meta-lessons + process-insights.** It
is a durable, validated doc (§6). The "onboarding playbook" the next instance consults is, in
practice, **the latest harvest artifact PLUS the framework-issue playbook** — two complementary
stores, each holding what it is shaped for. The umbrella's §6.2 wording ("the #634 playbook
auto-seed extended to process improvements") is corrected here: #634 auto-promotes *fixed
generalizable framework-issues* to `candidate` entirely inside the ledger; it does **not** and
cannot carry process meta-lessons. The two mechanisms are distinct (integration finding).

**(c) Ledger seeding is optional, candidate-only, and best-effort.** Where a harvested item is a
*genuine generalizable bug-class issue* (not process wisdom), the procedure MAY record it via
`POST /framework-issues/observe` with the **source** framework tag (`codex-cli`, never the
target — else the `framework != targetFramework` playbook filter would exclude it), the closest
fitting generalizable bucket, and a terminal status only when that is truthful. Honest
constraints, stated in the artifact:
  - such a seed can reach at most `playbook_status='candidate'`; **Echo cannot self-promote to
    `extracted`** (the ledger throws by design — the non-Echo attestation is Codey's or Justin's,
    later);
  - the populate path is a known open bug (task #50); the harvest must **not depend** on the seed
    surfacing. `seededToPlaybook` records only writes the ledger *confirms* (id returned), and the
    artifact states plainly that these are candidate, unattested, and pending #50.
- **No process meta-lesson is forced through the bug buckets to game promotion** (the exact
  hollow-data pattern the ledger guards against).

**Success no longer hinges on "appears in the playbook."** It hinges on the **artifact existing,
validating, and being the declared meta-lesson source for Step 1** (§11).

## 6. The harvest artifact (schema + location) and the procedure

**Artifact** → `docs/apprenticeship/retro-harvests/<from>-to-<to>-<instanceType>.md`
(e.g. `echo-to-codey-mentorship.md`). Path components are validated `^[a-z0-9-]+$` (no `/`, no
`..`); the writer/validator resolve the final path and assert it stays within
`docs/apprenticeship/retro-harvests/` (security finding). A machine-readable
`docs/apprenticeship/retro-harvests/INDEX.json` records the **latest harvest per instance-pair**
(round-3 finding — so any reader can deterministically discover "the onboarding source = latest
harvest + the playbook"); Step 0 writes the index, Step 1 *enforces* its use via the gate.
Frontmatter:

```yaml
---
schema: apprenticeship-retro-harvest/v1
instanceType: mentorship | apprenticeship
from: echo
to: codey
framework: codex-cli
harvestedAt: "<ISO>"
scopeMode: incremental | full          # default incremental (§8)
sourcesCovered:                        # COVERAGE EXTENT, not just presence (§8)
  ledger: { read: true, issueCount: <N> }     # issueCount snapshot — machine-checkable
  playbook: { read: true, entryCount: <N> }
  memory: { read: true, files: <N> }
  threads:
    - { id: 13435, fromTs: "<ISO>", toTs: "<ISO>", messagesRead: <N>, truncated: false }
    - { id: 458, fromTs: "<ISO>", toTs: "<ISO>", messagesRead: <N>, truncated: false }
  prs: [<pr#>, ...]
counts: { lessons: N, metaLessons: M, processInsights: K }
seededToPlaybook: [ { id: <ledger-id>, status: candidate, attested: false } ]
redaction: { scrubber: "<name@version>", findingsRemoved: <N>, scrubbedAt: "<ISO>" }  # §7
programNeeds: P                        # count reconciles against the §10 body list
fidelityReview: { reviewer: "<model/agent>", verdict: faithful|partial|rejected, at: "<ISO>" }
---
```

Body: the categorized lists (lessons / meta-lessons / process-insights), each item with a short
title, an **evidence pointer** in a canonical URI scheme (cross-model finding 4) — `ledger:<id>`,
`pr:<number>`, `thread:<id>#<msgId-or-ordinal>` (an **immutable message locator**, not a bare
timestamp — timestamps collide and messages may be deleted), `memory:<slug>@<contentHash>#<anchor>`
(slug + a source content-hash so anchor drift is detectable) — **pointers only, never quoted
secret/PII payloads** (§7) — and, for meta-lessons, the generalization statement. Plus the
`programNeeds` list (§10). **Validator-resolvable:** `ledger:` and `pr:` (deterministic).
**Fidelity-review-only:** `thread:` and `memory:` (resolved by sampled spot-check in §9; the
immutable locators above make that spot-check stable across time).

**Procedure** (`docs/apprenticeship/RETRO-HARVEST-PROCEDURE.md`, the standing how-to):
1. **Scope** — identify the prior instance + source set; default `scopeMode: incremental`
   (delta since the prior harvest's `harvestedAt`); `full` is explicit opt-in (§8).
2. **Read (bounded)** — walk the corpus under the token budget; chunk-and-reduce large threads;
   record true coverage extent (§8).
3. **Extract + classify** — every learning → primary (+optional secondary) kind (§4) with a
   resolvable evidence pointer; default to `lesson` (anti-skew, §4).
4. **Scrub** — run the existing secret/PII scrub (the same path `/corrections` uses — raw
   conversation is never stored) over the body BEFORE write and before any seed (§7).
5. **Dedup vs. playbook + prior harvests** — drop meta-lessons already generalized.
6. **Seed (optional, candidate-only)** — only genuine bug-class generalizable items, per §5(c);
   capture confirmed ids into `seededToPlaybook` with `attested:false`.
7. **Emit program-needs** — §10.
8. **Fidelity review (authority)** — an independent LLM reviewer judges harvest faithfulness
   against the corpus and stamps `fidelityReview` (§9). 
9. **Validate (signal)** — run the validator; the artifact isn't done until it passes AND the
   fidelity review is `faithful` (or `partial` with the gaps named).

## 7. Redaction invariant (security)

The harvest mines Telegram threads + agent memory — exactly where credentials, tunnel
`?sig=` URLs, dashboard PINs, Bearer tokens, and the user's PII live. Hard rules:
- The artifact body carries **pointers, not payloads** — never quoted thread/memory bodies.
- The **scrub runs before write and before any seed** (§6.4), reusing the existing
  correction-learning scrub path (raw conversation is never persisted).
- The **validator rejects secret-shaped strings** (`Bearer `, `?sig=`, long hex/base64 blobs,
  6-digit-PIN-shaped tokens, email patterns). This is a **limited backstop, NOT a scrub
  guarantee** (cross-model finding 5) — it will miss API keys, hostnames, sig-less session URLs,
  names, phone numbers, and contextual PII. The authoritative scrub is step §6.4; the artifact
  records the scrubber's own result metadata in frontmatter (`redaction: {scrubber, findingsRemoved,
  scrubbedAt}`) so the scrub's provenance is visible, not assumed.
- **Scrub-failure blocks the write** (round-3 finding): the validator requires `redaction.scrubber`
  to name a scrubber from an **approved list** with a non-failed status — a missing, failed, or
  unknown-version scrub refuses the artifact. The secret-pattern scan is the backstop; the
  *approved, succeeded scrub* is the gate.
- The artifact is **internal-repo-only** — never published via Telegraph or a public view.

## 8. Corpus bounding + incremental + budget (scalability)

- **Bounded read.** No source is read unboundedly. Threads over a token threshold use
  chunk-and-reduce (map: window→candidate findings; reduce: dedup/classify). `sourcesCovered`
  records `messagesRead` + `truncated` per thread so depth is honest, not just presence.
- **First harvest is `full`; incremental only with a baseline.** The **first** harvest for an
  instance-pair MUST be `scopeMode: full` — it has no prior baseline, and Justin's prerequisite is
  to review *ALL* notes. `incremental` (delta since the prior harvest's `harvestedAt`) is valid
  ONLY after a prior valid harvest exists for that same continuity boundary; the validator refuses
  `incremental` when no prior artifact is found. So the Echo→Codey harvest (this run) is `full`.
- **Incremental for later retros.** Once a baseline exists, `scopeMode: incremental` reads only
  the corpus *delta* since the prior harvest's `harvestedAt`; prior harvest artifacts are the
  memo, not re-derived inputs. So retro N costs ~O(new material), not O(all history).
- **Budget + completeness.** The harvest runs within the existing LLM budget / circuit-breaker
  substrate with a per-harvest token ceiling. On budget exhaustion it emits a **partial** artifact
  (`truncated:true` on the affected sources) rather than retrying unboundedly — BUT a partial
  first harvest does **not** satisfy the prerequisite. The artifact records
  `completeness: complete | partial-accepted`: the first Echo→Codey harvest must be `complete`
  (no critical source truncated), OR `partial-accepted` with the named gaps explicitly accepted by
  Justin. Budget-truncation alone can never silently satisfy the "ALL notes" prerequisite
  (cross-model finding, round 3).

## 9. Validator (signal) + fidelity review (authority) — applying the constitution

Per **The Body and the Mind / Signal vs Authority**: the structural validator is the *signal*;
an LLM fidelity review is the *authority* for "is this a faithful harvest." The original draft
let a structural-only validator hold the "is this real?" authority — a Signal-vs-Authority
inversion. Corrected:

**Validator (`scripts/validate-retro-harvest.mjs`, pure, no HTTP route, no `src/` import, no DI):**
- required frontmatter fields present; `counts`/`programNeeds` reconcile against the body;
- `sourcesCovered` carries coverage extent (not bare booleans);
- **evidence pointers are well-formed** in their declared URI scheme (§6) and the
  *validator-resolvable* classes resolve: every `seededToPlaybook` id exists at `candidate`+ in
  the live ledger (stable — promotion only moves forward); `pr:<n>` is well-formed; `thread:<id>`
  is in the known set;
- **counts are validated as recorded watermarks, NOT against mutable live state** (cross-model
  finding 3): `sourcesCovered.*.issueCount`/`entryCount` are snapshots **as of `harvestedAt`** —
  the validator checks they reconcile with the artifact's own body counts, and that they were
  accurate *at creation* (the fidelity review's job, below). The validator does **not** compare
  them to today's live counts — a historical artifact must not fail after unrelated ledger growth
  (the classic event-sourcing "validate snapshot against current state" mistake).
- **secret-pattern rejection** (§7) — a *limited backstop*, not a scrub guarantee (§7);
- path-confinement (§6).
This is the only code Step 0 ships. **E2E tier is genuinely n/a** (pure CLI, no route) — the
§9 escape clause about "maybe a route later" is deleted: a route, if ever wanted, is a different
step with its own E2E.

**Fidelity review (authority) — concrete protocol** (cross-model finding 1): an LLM reviewer
that is **independent of the harvesting pass** (a different agent/model invocation, not the one
that authored the artifact) reads the artifact against the corpus and stamps
`fidelityReview.verdict` ∈ {faithful, partial, rejected}. The review is operational, not a prose
rubber-stamp:
- **Sampled source coverage** — it must spot-check a minimum sample of evidence pointers per
  source class (e.g. ≥3 ledger ids, ≥3 thread pointers, ≥2 memory slugs, where they exist),
  *resolving each* and confirming the artifact's claim matches the source.
- **Watermark accuracy** — it confirms the `sourcesCovered` counts were accurate at `harvestedAt`
  (the creation-time check the validator deliberately does not re-run later).
- **Rubric fields** — coverage adequacy, classification correctness (esp. the anti-skew default-
  to-lesson, §4), no-hallucinated-items, redaction-clean.
- **`partial` must name the gaps** — which sources were under-covered or which items couldn't be
  verified — in the artifact body. `rejected` blocks. This is what makes "done" mean *faithful*,
  not merely *well-shaped* (Signal vs Authority).
- **Inspectable audit bundle** (round-3 finding — "the decision is audited" half of *The Body and
  the Mind*): the verdict ships with a deterministic, human-inspectable
  `fidelityReview.audit` — the sampled evidence ids, what each resolved to, the per-sample
  reviewer note, and the pass/fail per rubric field. The LLM *synthesizes the verdict*; the audit
  bundle makes that judgment re-checkable by a human or a future tool, so the authority is
  model-mediated but never opaque.

## 10. The "what the program needs" output (schematized)

A schematized section of the artifact (and the concrete Step-1 handoff). Each need:
`{ id, motivatedBy: <process-insight pointer>, priority: high|med|low, statement }`. The
frontmatter `programNeeds: P` count reconciles against this list (validator-checked). **Step 1's
spec is required to cite these need-ids** — so the umbrella's "nothing in Step 1 is built that
isn't traceable to a program-need" claim becomes *checkable*, not aspirational. Illustrative
(real list produced when Step 0 is built):
- `need-001` *(motivatedBy: dual-vantage process-insight)* — the differential read-channel must
  surface the mentee's raw streams to the overseer.
- `need-002` *(motivatedBy: "issues found by hand never reached the ledger")* — the
  doc-as-required-artifact gate must block instance-complete without ledger entries.

## 11. Testing (3-tier, scoped to what Step 0 ships)

- **Unit** (`tests/unit/`): `validate-retro-harvest` — valid artifact passes; each missing
  required field fails; count/body mismatch fails; missing coverage-extent fails; an unresolvable
  evidence pointer fails; a secret-shaped string fails; a path-escape fails. Both sides of every
  boundary.
- **Integration** (`tests/integration/`): (a) the validator run against the *actual*
  `echo-to-codey-mentorship.md` passes (fixture-of-record); (b) **if** any item is seeded, an
  integration test asserts the candidate row exists in the live ledger at `candidate` and is
  tagged with the source framework — *or*, if #50 blocks surfacing, the test asserts the honest
  candidate-only state and the documented dependency (no silent pass).
- **E2E/wiring:** n/a for the pure validator (no route, no DI). The "feature is alive" surface for
  this step is the validated artifact + the reconciled counts, exercised by the integration test.

## 12. Agent-Awareness (explicitly deferred to Step 1)

Step 0 ships an artifact + procedure + validator, but **does not** add a `generateClaudeMd()`
entry. Rationale: the capability future agents must *know to invoke* is "a valid retro-harvest is
required before an instance starts" — and that gate + its discoverability are Step 1's job (§13).
Adding awareness now, before the gate exists, would advertise an unenforced step. Step 1's spec
owns the Agent-Awareness + Migration-Parity surface for the harvest. (Recorded here so the
deferral is a stated boundary, not an omission.)

## 13. Step 0 / Step 1 boundary rationale (no defer-to-future-self)

Step 0 genuinely *precedes* Step 1: you cannot wire a gate that "requires a valid harvest" before
a harvest artifact + its schema + its validator exist. So Step 0 = the artifact, the repeatable
procedure, and the validator (the signal the gate will call); Step 1 = the gate that makes a
valid harvest *required*, plus its Agent-Awareness + Migration-Parity wiring. This is a real
phase boundary, not the "Phase 2 / defer-to-future-self" anti-pattern — the deferred piece
cannot be contained in Step 0 (it depends on Step 0's outputs). **Close-the-Loop honesty:** Step
0 does *not* itself re-surface the harvest on a cadence (that *is* the gate, Step 1); §14's
constitution tie-in is corrected to claim only what Step 0 delivers.

## 14. Risks

- **Harvest is subjective / hallucinated.** Mitigations: evidence-pointer + resolvability
  (§9), the LLM fidelity review as authority (§9), the anti-skew default-to-lesson rule (§4).
- **Secret/PII leak.** Mitigation: the redaction invariant (§7) — pointers-not-payloads + scrub +
  validator pattern-rejection + internal-only.
- **Scope creep into "fixing" what the harvest finds.** Mitigation: Step 0 *records* (ledger
  entry + program-need); it does not fix. A found bug is a pointer, not an in-step detour.
- **Dependence on the broken populate path (#50).** Mitigation: seeding is best-effort,
  candidate-only, and success does not hinge on it (§5c, §11).

## 15. Convergence changelog (round 1 → this version)

- **Seed mechanism corrected** (§5): harvest artifact is authoritative for meta-lessons; ledger
  seeding is optional, candidate-only, source-framework-tagged, #50-independent. Removed the
  false "appears in `GET /playbook`" success criterion.
- **Security**: added the redaction invariant (§7).
- **Signal vs Authority**: validator demoted to signal; LLM fidelity review added as authority
  (§9) — applies the just-ratified constitution article.
- **Scalability**: corpus bounding + incremental default + budget (§8); coverage-extent schema.
- **Taxonomy**: primary+secondary + anti-skew default-to-lesson (§4).
- **Traceability**: `programNeeds` schematized + count-reconciled + Step-1-must-cite (§10).
- **Scope**: validator fixed as pure-CLI/no-route; deleted the "maybe a route later" escape (§9).
- **Honesty**: Agent-Awareness explicitly deferred to Step 1 (§12); #634-vs-manual-seed
  disambiguated (§5b); Close-the-Loop overclaim corrected (§13).

**Round 2 (codex cross-model, gpt-5.5) → this version:**
- **First harvest must be `full`** scope, not incremental — no baseline exists and the
  prerequisite is "ALL notes"; incremental only with a prior baseline (§8).
- **Count validation de-brittled**: snapshots are watermarks as-of-`harvestedAt`, validated at
  creation (fidelity review), never compared to mutable live counts (§9) — avoids the
  event-sourcing "validate snapshot against current state" mistake.
- **Fidelity-review protocol made operational** (§9): independence, sampled per-source pointer
  resolution, watermark-accuracy check, rubric fields, what `partial` must name.
- **Evidence-pointer URI scheme** defined + validator-resolvable vs fidelity-review-only split (§6).
- **Secret-scan labeled a limited backstop**; scrubber result metadata recorded in frontmatter (§7).

## 16. Relationship to the constitution / process

Step 0 is **Close-the-Loop's first harvest** (the re-surfacing cadence is Step 1's gate), an
application of **Signal vs Authority / The Body and the Mind** (validator=signal, LLM
review=authority), and **Structure > Willpower** (the redaction + resolvability + coverage-extent
checks replace "trust the harvester"). It is a **Tier-2 spec** under the approved Tier-3 umbrella;
it goes through `/spec-converge` with codex cross-model review before build, per the Tiered
Development Process.
