---
title: "Apprenticeship Step 1 — Minimal Program Scaffold (instance registry + lifecycle gates)"
status: draft
tier: 2
parent: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
parent-principle: Structure beats Willpower
step: 1
approved: true
approver: justin
approved-at: "2026-06-02T04:33:00Z"
approval-basis: "Justin, topic 13435, 2026-06-01: 'you make sure to spec review and cross model review and generate to convergence for all specs but I'm gonna go ahead and preapproved everything however, when I come back, I can review the specs afterwards.' Pre-approval for the 12h autonomous run; full /spec-converge + codex cross-model ran (converged, codex-cli:gpt-5.5); Justin reviews the converged spec after the fact."
author: Echo
date: 2026-06-01
topic: 13435
slug: APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC
companion: APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC.eli16.md
eli16-overview: APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC.eli16.md
builds_on:
  - APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
  - APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.md
review-convergence: "2026-06-02T04:51:36.576Z"
review-iterations: 3
review-completed-at: "2026-06-02T04:51:36.576Z"
review-report: "docs/specs/reports/APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Apprenticeship Step 1 — Minimal Program Scaffold

**Parent:** `APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md` · **parent-principle:** Structure beats Willpower
**Step:** 1 of 5 — the standing structure the first instance (Codey→Gemini) plugs into.
**Consumes:** the Echo→Codey harvest's need-001..005. **Author:** Echo · **Topic:** 13435

> **Convergence note (round 1).** Reviewers (grounded in the live codebase) caught: (1) a
> `src/`-imports-`scripts/.mjs` claim that cannot compile — corrected by extracting the validator
> logic into `src/core/retroHarvestValidator.ts` as the source of truth (§3.2); (2) the gates were
> "advisory" and bypassable — corrected so the **state-mutating transition itself** consults the
> gate (§3.4); (3) `requiredArtifacts` booleans were self-certifying via PATCH — corrected so the
> gate **re-derives truth from injected deps**, never trusts a stored flag (§3.3–3.4); (4)
> `harvestRef` path traversal — corrected to recompute the canonical confined path (§3.5); (5)
> missing `parent-principle` (would fail the traceability ship-gate) — added; (6) Signal-vs-Authority
> framing — the gates are **structural preconditions on objective artifacts**, not quality judgments,
> and verdicts are audited (§3.6); (7) prose need-sequencing → a **tracked `programNeeds`** field
> (§4); plus AgentServer/RouteContext wiring, `migrateClaudeMd()`, atomic writes, a status table,
> and charset clamps. Full changelog: §10.

## 1. Problem

Each apprenticeship/mentorship instance is its own project under a standing **program** that
crystallizes by bootstrap (umbrella §7). Step 0 produced the first retro-harvest, the validator,
and the latest-harvest `INDEX.json`, and emitted prioritized program-needs (need-001..005). But
there is no program *structure*: nothing tracks an instance as a project, nothing **requires** a
valid retro-harvest before a new instance starts (the **retro-gate**), and nothing **requires** an
instance's lessons be captured before it closes (the **doc-as-required-artifact gate**). Without
that structure the first Codey→Gemini instance is unbounded and its learnings can evaporate —
exactly the failure the harvest exists to prevent.

## 2. Goals / Non-goals

**Goals**
1. **Instance-as-project registry** with the locked role triple (overseer / apprentice+mentor /
   mentee), framework, status, and the required-artifact checklist.
2. **Retro-gate** — a `pending→active` transition is *refused server-side* unless the prior
   instance's retro-harvest exists at its **canonical confined path** and passes the Step 0
   validator (the first instance is seeded by the Echo→Codey bootstrap harvest).
3. **Doc-as-required-artifact gate** (need-002) — an `active→complete` transition is refused until
   the instance's required artifacts are **verified present from live state** (not a stored flag).
4. Cite all five harvest needs and make the sequencing of the later-step ones **tracked + checkable**
   (a `programNeeds` field with target step + validated `honoredBy`), never prose-only (Close-the-Loop). <!-- tracked: programNeeds §4 -->

**Non-goals**
- *Implementing* the differential read-channel (need-001) — Step 4. Step 1 **resolves its location**
  (umbrella §9.2): the differential computation will live on an `ApprenticeshipOverseer` surface,
  declared here as a typed no-op interface and implemented in Step 4.
- The runtime adapter / install / live mentorship — Steps 2-4.
- Changing the retro-harvest *schema* — Step 0 owns it. (Step 1 DOES relocate the validator's pure
  logic src-ward — a deliberate, called-out Step-0-boundary touch, §3.2.)

## 3. Design

### 3.1 State (file-based, atomic, per Instar convention)
`.instar/apprenticeship/instances.json` — runtime state (gitignored). Atomic write
(`${path}.${pid}.tmp` → `fs.renameSync`) prevents torn writes; on top of that, **all
load-mutate-save sequences run through one in-process serialized mutator with an optimistic
`version` CAS** (re-read + bump `version` under the lock; a stale version aborts + retries) — atomic
rename alone does not stop lost updates from two concurrent handlers (round-2 finding). This assumes
the **single-process-per-agent** AgentServer model instar already runs (one Node process owns the
store); the multi-machine pool keeps per-agent state on its owning machine, so cross-process contention
is out of scope for Step 1 (round-3 finding — stated, not assumed). A corrupt/unparseable store
**fails closed** (gates return `allow:false` with a clear reason, never "no prior instance → open the
gate"). Instance schema:

```ts
interface ApprenticeshipInstance {
  id: string;                       // create-time clamp ^[a-z0-9-]+$ ; unique (dup-create rejected)
  instanceType: 'apprenticeship' | 'mentorship';
  overseer: string; mentor: string; mentee: string;   // each ^[a-z0-9-]+$
  framework: string;                // ^[a-z0-9-]+$ (flows into the ledger-count query)
  status: 'pending' | 'active' | 'complete' | 'blocked';
  priorInstanceId: string | null;   // for the retro-gate; must resolve to a `complete` instance
  requiredArtifacts: {              // the CHECKLIST DEFINITION (what's required), not evidence
    retroHarvest: boolean; ledgerEntries: boolean; detectorAudit: boolean;
  };
  programNeeds: Array<{ id: string; targetStep: number; honoredBy: string | null }>; // tracked sequencing
  harvestFrom: string; harvestTo: string;  // canonical harvest identity, computed at create (§3.5)
  harvestRef: string | null;        // recorded for humans; NEVER the resolution source (§3.5)
  version: number;                  // optimistic-CAS counter for the serialized mutator (§3.1)
  createdAt: string; updatedAt: string;
}
```

**Role → harvest mapping (computed + stored at create; round-2/3 finding).** A harvest is named for
the relationship it retrospects (the mentoring edge), so `harvestFrom = mentor`, `harvestTo = mentee`
for both instance types. Concretely:

| instanceType | overseer | mentor (= harvestFrom) | mentee (= harvestTo) | example artifact |
|---|---|---|---|---|
| apprenticeship | (none above) | echo | codey | `echo-to-codey-apprenticeship.md` |
| mentorship | echo | codey | gemini | `codey-to-gemini-mentorship.md` |

(The umbrella's "apprentice+mentor" is one agent, Codey, in the **`mentor`** field — it is apprentice
*to Echo* and mentor *to the mentee*.) The bootstrap prior harvest is `echo-to-codey-mentorship` (the
Echo→Codey relationship Step 0 retrospected). The canonical path (§3.5) is derived ONLY from these
stored normalized fields, never re-inferred from the role triple at read time.

### 3.2 Validator relocation (the corrected integration)
The pure validator logic moves to **`src/core/retroHarvestValidator.ts`** (the source of truth;
`js-yaml`-only, already a runtime dep). `scripts/validate-retro-harvest.mjs` becomes a thin CLI that
re-exports from `dist/core/retroHarvestValidator.js` (the existing `BackfillCore` precedent). So
`ApprenticeshipProgram` imports `validateRetroHarvest` from `src/core/retroHarvestValidator` —
in-process, typed, unit-testable. Step 0's artifacts + its tests are unchanged behaviorally (the
`.mjs` keeps its CLI + exports). This is the one deliberate Step-0-boundary touch.

### 3.3 Gate logic (pure; truth re-derived from injected deps)
`src/core/ApprenticeshipProgram.ts`, a class over the store with pure gates:
- **`evaluateStartGate(instance, deps)`** → the retro-gate. `priorInstanceId === null` → the
  bootstrap seed (the Echo→Codey artifact at its canonical path) must exist + validate. Else the prior
  instance must be `status:'complete'` AND its canonical harvest must exist + validate. Returns
  `{allow, reason}`. **`partial-accepted` passes only with acceptance metadata** (round-2 finding):
  the harvest frontmatter must carry `acceptedBy` + `acceptedAt` (Step 0 §8: partial is valid only
  with the named gaps explicitly accepted) — a bare `partial-accepted` enum without an acceptance
  record is `allow:false` ("partial harvest awaiting acceptance"). `complete` always passes.
  **Trust boundary (round-2 finding):** the gate trusts ONLY the structural validator + the harvest's
  *recorded* `fidelityReview` stamp; it does NOT re-judge fidelity (that authority was Step 0's
  independent review pass — a forged stamp is not re-caught here, by design).
- **`evaluateCompletionGate(instance, deps)`** → the doc-gate. Returns `{allow, reason, missing[]}`.
  Each `requiredArtifacts` flag the instance *declares required* is checked **against live state via
  injected deps** — `harvestExists+validates` (fs+validator), an **instance-scoped** ledger check
  (round-3 finding: `≥1` ledger entry for the instance's framework whose `relatedSpec`/instance tag
  references *this* instance — not merely any framework entry, so unrelated history can't satisfy it),
  `detectorAuditExists` — and `checkLiveLedger` resolves any `seededToPlaybook` ids against the live
  ledger, not self-report. **A stored `requiredArtifacts:true` is NEVER treated as evidence of
  presence.** **Acceptance-field provenance** (round-3 finding): `acceptedBy`/`acceptedAt` on a
  `partial-accepted` harvest are written only by the human approver through the authenticated approval
  path (not an agent self-write); `fidelityReview` is Step 0's independent reviewer's stamp. The gate
  records which it trusted in the decision audit (§3.6).

### 3.4 Routes + transition enforcement (the gates are not advisory)
Mounted on `RouteContext` in `src/server/routes.ts`, constructed in `src/server/AgentServer.ts`
(nullable field → `503` when absent; the E2E asserts 200). Bearer-auth on every route.
- `GET /apprenticeship/instances` · `GET /apprenticeship/instances/:id` (read).
- `POST /apprenticeship/instances` (create; charset-clamped, dup-rejected).
- `POST /apprenticeship/instances/:id/transition` `{to}` — the **only** way status changes.
  `pending→active` runs `evaluateStartGate` and **refuses on `allow:false`**; `active→complete` runs
  `evaluateCompletionGate`; `active→blocked` / `blocked→active` (re-gate) allowed; **`complete` is
  terminal**. Any transition not in the table is rejected with a reason. `requiredArtifacts` is
  **immutable after create** (or settable only to *raise* requirements, never to mark met).
- `POST /apprenticeship/instances/:id/can-start` · `.../can-complete` — **read-only previews** of the
  gate verdict (no mutation).

### 3.5 Path confinement (no traversal)
The gate **never reads a stored `harvestRef`/`INDEX` path directly**. It recomputes the canonical
path via Step 0's `safeArtifactPath(harvestFrom, harvestTo, instanceType)` (using the normalized
create-time fields from §3.1, charset-clamped, `..`-rejected, confined to `HARVEST_DIR`) and reads
only that. A stored `harvestRef` that disagrees with the canonical one is ignored for resolution
(and may be flagged).

### 3.6 Signal vs Authority + decision audit
The gates are **structural preconditions on OBJECTIVE artifacts** — "does a validated harvest exist?",
"is there ≥1 ledger entry?" — fully-specified binary facts, the legitimate place for a structural
decision (like the ship-gate's "side-effects artifact present"). They are **NOT quality judgments**:
whether the mentor truly internalized the lessons, or the audit was real, stays with the **overseer
(the mind)**, informed by the gate. Every gate verdict (allow/refuse + reason + instance id) is
appended to `logs/apprenticeship-decisions.jsonl` — the audit that makes "the mind decides" a record,
not a loophole (The Body and the Mind).

## 4. Traceability — every need cited AND tracked (Close-the-Loop)
The instance's `programNeeds` array carries each need with its target step + an `honoredBy` slot:
- **need-002** doc-gate → satisfied here (`requiredArtifacts.ledgerEntries` + §3.3).
- **need-003** detector audit → `requiredArtifacts.detectorAudit` gated here; *run* in Step 2/3.
- **need-001** differential channel → `{id:'need-001', targetStep:4, honoredBy:null}`; location
  resolved here (§2: the `ApprenticeshipOverseer` no-op interface), implemented Step 4.
- **need-004** non-Claude ship path → `{targetStep:2}`. **need-005** warm mentor session → `{targetStep:4}`.
`honoredBy` is **not a self-certifying boolean** (round-2 finding): it must reference a concrete,
resolvable artifact — a merged spec slug (`docs/specs/<slug>.md` that exists) or a `pr:<n>` — and a
later step's gate (or a review job) validates that the reference actually resolves before treating the
need as honored. An `honoredBy` that doesn't resolve is treated as still-open. A tracked loop, not a
prose intention.

## 5. Testing (3-tier, NON-NEGOTIABLE)
- **Unit:** `ApprenticeshipProgram` gates both sides (start allowed with valid bootstrap/prior
  harvest incl. `partial-accepted`; refused when harvest missing/invalid OR prior not `complete`;
  completion refused per each missing live artifact; allowed when all live-verified). Status-table
  transitions (legal allowed, illegal rejected, `complete` terminal). Charset clamp + dup-reject.
  Path-confinement (a traversal `harvestRef` is ignored, canonical path used). Wiring-integrity: the
  injected validator + ledger-counter are **real, not no-ops**.
- **Integration:** the HTTP routes incl. **auth-negative** (no/wrong token → 401/403), create →
  transition gating end to end, the decision-audit line is written.
- **E2E:** Phase-1 "feature is alive" — `/apprenticeship/instances` returns 200 through `AgentServer`.

## 6. Migration Parity + Agent-Awareness
- **Agent-Awareness:** add an Apprenticeship Program section to **both** `generateClaudeMd()` (new
  agents) AND a **`migrateClaudeMd()`** content-sniff entry (existing agents) — the omission of the
  latter was a round-1 finding.
- **Migration Parity:** `instances.json` is runtime state (no migration). **No config flag:** the
  scaffold is additive, passive (a registry + gates nothing else depends on yet), and actively needed
  for the Gemini onboarding this run — so it ships on, with no `apprenticeship.enabled` gate (decided,
  not left conditional). If a future step needs a dark-ship flag, that step adds it via `migrateConfig()`.
- **Publish:** touches `src/core` + `src/server` → a `NEXT.md` publish entry is mandatory.

## 7. Risks
- **Over-building past bootstrap.** Mitigation: only the registry + 2 gates + role model + the
  overseer no-op interface; everything else tracked in `programNeeds` to its step.
- **Gate false-block.** Verdicts are advisory to the program's own lifecycle, surfaced with a reason +
  audited; a wrong verdict stalls one instance transition, not the fleet.
- **Validator relocation regressing Step 0.** Mitigation: Step 0's tests run against the relocated
  logic (re-exported), unchanged behavior; the `.mjs` CLI + exports preserved.

## 8. Relationship to the constitution / process
Step 1 is **Structure > Willpower** (the gates make "review before you start / capture before you
close" unskippable at the transition), **Signal vs Authority / The Body and the Mind** (structural
preconditions inform; quality stays with the overseer; verdicts audited), and **Close-the-Loop** (the
retro-gate re-surfaces the prior harvest; `programNeeds` tracks the later-step needs <!-- tracked: programNeeds §4 -->). Tier-2 under the
approved umbrella; converged via `/spec-converge` + codex cross-model before build.

## 10. Convergence changelog (round 1 → this version)
- Validator relocated to `src/core/retroHarvestValidator.ts` (the `src`-imports-`.mjs` claim couldn't
  compile) (§3.2). Gates now enforce at the **transition**, not advisory (§3.4). `requiredArtifacts`
  truth **re-derived from live deps**, never a stored flag; immutable after create (§3.3-3.4).
  `harvestRef` path traversal closed via canonical-path recompute (§3.5). Added `parent-principle`
  (frontmatter). Signal-vs-Authority framing + decision-audit (§3.6). Prose need-sequencing →
  tracked `programNeeds` + §9.2 differential-location resolved (§4, §2). Wiring → AgentServer +
  RouteContext (§3.4). Added `migrateClaudeMd()` (§6), atomic writes + fail-closed (§3.1), status
  transition table + `complete` terminal + prior-must-be-complete (§3.4), charset clamp + dup-reject
  (§3.1), auth-negative tests (§5), `partial-accepted`-passes-bootstrap (§3.3).
- **Round 2-3 (codex gpt-5.5):** `partial-accepted` requires `acceptedBy`/`acceptedAt` acceptance
  metadata (§3.3); real CAS `version` not just atomic-rename + single-process-assumption stated
  (§3.1); explicit role→harvest mapping table + stored `harvestFrom`/`harvestTo` (§3.1/3.5);
  `honoredBy` must reference a resolvable spec/PR, validated (§4); instance-scoped ledger check (§3.3);
  acceptance-field provenance (human approver writes `acceptedBy`) (§3.3); explicit LLM-trust boundary
  (gate trusts structural validator + recorded stamp, doesn't re-judge) (§3.3).
