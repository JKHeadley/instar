---
title: "Standards Enforcement-Coverage Audit"
slug: "cartographer-conformance-audit"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "cartographer-conformance-audit.eli16.md"
status: "approved"
approved: true
project: "cartographer-conformance"
spec_number: 3
depends-on: "cartographer-doc-tree-schema (spec #1)"
review-convergence: "2026-06-10T17:20:57Z"
review-iterations: 2
review-completed-at: "2026-06-10T17:20:57Z"
---

# Standards Enforcement-Coverage Audit

> Spec #3 of `cartographer-conformance`. The "registry-wide conformance gate" the
> constitution names but has not built — scoped to the version that is cheap,
> deterministic, and **valuable today**.
>
> **Design history (two rejected drafts, both killed at convergence).** v1 (per-node
> LLM audit of code against all standards) was economically intractable (~$320/pass
> on Opus, no caching, never converges). v2 (narrowed to node-scoped non-lint
> standards) was found at round-2 convergence to be a **no-op armature**: every
> constitutional standard checkable from a single code file is *already* enforced by
> a cheaper deterministic CI lint/ratchet, so an LLM code-vs-standards auditor would
> produce zero findings — a large machine for no value, plus it leaned on prompt-
> caching the substrate lacks and a PIN-scoping primitive that does not exist.
>
> **v3 (this spec) inverts the question.** Don't ask "does this code violate a
> standard?" (already lint-covered or not node-checkable). Ask the question the
> constitution actually cares about and *cannot currently answer*: **"for each
> standard in `docs/STANDARDS-REGISTRY.md`, does a real structural guard exist — a
> lint, a test ratchet, a gate, a hook — or is it still just a sentence someone has
> to remember?"** That is *Structure beats Willpower* made measurable: it surfaces
> the standards that are wishes, not guarantees. Mostly deterministic (the registry
> prose names each standard's enforcement), so cheap and convergent by construction.

## Problem statement

The constitution declares its own enforcement throughout: nearly every article carries
an **"Applied through."** / **"In practice."** line naming the mechanism that enforces
it (`tests/unit/no-silent-llm-fallback.test.ts`, `B16_UNVERIFIED_WALL` in
`MessagingToneGate`, `POST /spec/conformance-check`, a `scripts/lint-*.js`, …). But
nothing **verifies** those claims, and the registry itself admits drift in prose:
*"the registry-wide conformance gate is built … but not yet auto-invoked"*, *"the
Usher … is not yet implemented"*. A standard whose named guard was renamed, removed,
or never built is silently a wish wearing the costume of a guarantee — the exact
"looks protected while being fake-protected" failure mode the **No Silent Degradation**
standard names, applied to the constitution itself.

This spec builds the registry-wide enforcement-coverage audit: it parses each
standard's declared enforcement references, **verifies each referenced artifact
actually exists** on disk, classifies the standard's enforcement strength, and
surfaces the **gaps** (standards with no verifiable structural guard). Observe-only,
non-gating, deterministic-first.

**Observe-only, non-gating (hard boundary).** It NEVER blocks anything. It produces a
read-only coverage report + a CI ratchet floor on the enforced ratio. "Signal vs.
Authority": a coverage gap is a signal to build a guard, never an automatic block.

## Foundation contract (verified against real source)

| Primitive | Source (verified) | Use |
|---|---|---|
| registry parse | `StandardsRegistryParser` (`src/core/StandardsRegistryParser.ts`) | parses `docs/STANDARDS-REGISTRY.md` `### ` articles → `{ family, name, rule, inPractice }[]` deterministically, ~30+ articles. v3 extends parsing to ALSO capture the `**Applied through.**` line (and scan `inPractice` + `appliedThrough` text for enforcement references). |
| repo file existence | `fs` | verify a referenced path (`scripts/lint-*.js`, `tests/**/*.test.ts`, `docs/specs/*.md`, `src/**`) exists. |
| route existence | `src/server/routes.ts` scan | verify a referenced `GET/POST /…` route is registered (regex over the routes source, the `docs-coverage.mjs` pattern). |
| gate/symbol existence | repo grep | verify a referenced gate/marker symbol (`B16_UNVERIFIED_WALL`, `MessagingToneGate`, `failureSwap`) is present in source. |
| (optional, dark) light classify | `IntelligenceRouter` + the spec #2 off-Claude probe pattern | for a standard whose enforcement is NOT deterministically resolvable from its prose, an OPTIONAL bounded light-tier pass suggests likely guard / confirms unguarded. Advisory only (Signal vs. Authority); the deterministic classification is the authority; ships dark, off-Claude-probe-gated. |

This spec touches **no merged spec #2 code**. It reuses `StandardsRegistryParser`
(shipped) and the deterministic-script pattern of `scripts/docs-coverage.mjs`.

## Proposed design

### Part A — Reference extraction (deterministic)

Extend `StandardsRegistryParser` to capture, per article, the `**Applied through.**`
line in addition to `rule`/`inPractice` (an additive field `appliedThrough?: string`;
the existing canary stays green). A new pure `StandardEnforcementExtractor` then pulls
**enforcement references** from `inPractice` + `appliedThrough`:

- **File paths** — `` `scripts/lint-*.js` ``, `` `tests/**/*.test.ts` ``,
  `` `docs/specs/*.md` ``, `` `src/**/*.ts` `` (backtick-fenced or bare path tokens).
- **Routes** — `` `GET /…` `` / `` `POST /…` `` tokens.
- **Symbols/markers** — `CONSTANT_CASE` gate markers + named classes (`MessagingToneGate`,
  `IntelligenceRouter.failureSwap`).
- **PR/issue refs** (`#NNN`) are recorded but NOT treated as enforcement (they're
  provenance, not a live guard).

Extraction is conservative: a reference is only counted if it matches a known
enforcement shape. Unmatched prose contributes no reference (→ the standard reads as
having no *named* guard, which is itself the signal).

### Part B — Verification + classification (deterministic)

For each extracted reference, verify it resolves against the live repo:

- a file path → `fs.existsSync`;
- a route → present in the `routes.ts` route table (regex scan);
- a symbol/marker → present in `src/**` (bounded grep).

Each standard is then classified by its STRONGEST verified guard:

| `enforcementKind` | meaning |
|---|---|
| `ratchet` | a verified `no-*`/`*-coverage`/`*.test.ts` CI ratchet exists (the strongest — a guard that fails CI on regression). |
| `gate` | a verified gate/hook/route guard (precommit, `MessagingToneGate` marker, server gate). |
| `lint` | a verified `scripts/lint-*.js`. |
| `spec-only` | only a `docs/specs/*.md` is referenced (designed, maybe not enforced). |
| `documented-only` | references exist in prose but NONE verify on disk, OR no enforcement reference at all — **a gap**. |

A `coverage` record per standard: `{ standard, family, enforcementKind, guards:
[{ ref, kind, verified }], danglingRefs: [refs named but NOT found on disk],
classifiedAt }`. **Dangling refs are a first-class signal** — a standard naming
`tests/unit/foo.test.ts` that no longer exists is a *broken* guarantee, louder than a
never-guarded one.

### Part C — The audit run + convergence

- A cheap, deterministic **`StandardsEnforcementAuditor`** computes the full coverage
  in one pass (parse + extract + verify — no LLM, milliseconds). It is **idempotent
  and pure-deterministic**, so it converges trivially: re-running on unchanged
  registry+repo yields byte-identical output (no nondeterminism, unlike the rejected
  LLM design). "Converged" is the normal state; the signal is *change* in the gap set.
- A short-circuit on the registry content-hash + a repo-structure hash (the
  `docs-coverage.mjs` root-tree-oid pattern) skips recompute when nothing changed.
- **Optional dark light-LLM enrichment** (Part-D below) is the only non-deterministic
  part and is OFF by default; the deterministic coverage is always the authority.

### Part D — Surfaces, store, driver

- **Read surfaces (owner-Bearer; see Security):**
  - `GET /conformance/coverage` — the full per-standard coverage report (filters
    `?family=`, `?kind=`, `?status=gap`). Read-only.
  - `GET /conformance/coverage/health` — counts by `enforcementKind`, the enforced
    ratio (`ratchet+gate+lint` / total), the gap list (`documented-only`), the
    dangling-ref count, last-computed time, `converged` (always true for the
    deterministic pass). Mirrors `/cartographer/health`.
- **Store.** The latest report is written to `state/standards-coverage.json` (a single
  compacted current-state document — bounded by the standards count, ~30 rows; no
  unbounded growth, no rotation needed). Output-only; never the read baseline for the
  ratchet (Part E).
- **Driver.** No expensive poller is needed (the pass is deterministic + cheap). A
  lightweight scheduler **job** (`standards-coverage-audit`, dark/off by default)
  recomputes on a slow cadence and raises ONE aggregated Attention/Degradation item
  ONLY when the gap set GROWS (a new unguarded standard, or a newly-dangling ref) —
  never one-per-standard (Bounded Notification Surface; burst test). The route also
  recomputes on demand. Lease-gated when the job runs (single-writer).

### Part E — CI ratchet (the standing guard, observe-only at the repo level)

A `scripts/standards-coverage.mjs --check` (parity with `docs-coverage.mjs`): a
hardcoded committed floor on the enforced ratio + a hard zero ceiling on **dangling
refs** (a standard must never reference a guard that doesn't exist). Fails the build
on regression — a new standard shipped with no guard, or a guard file removed while
a standard still cites it. The floor starts at the current measured ratio and
ratchets up as gaps are closed (the docs-coverage "starts loose" rationale). The
written `state/standards-coverage.json` is measurement-only, never the floor.

## Security & data-egress

- **Deterministic core sends nothing anywhere** — it reads local files only. Zero
  egress in the default configuration (the optional dark LLM enrichment is the only
  egress path, and it inherits spec #2's posture: off-Claude probe, separate
  `egressAcknowledged`, secret-excluded, bounded — but it ships OFF).
- **The coverage report names where the constitution is UNGUARDED** — a lighter
  sensitivity than spec #2's "where the code violates safety" (it's meta: which
  standards lack guards, not exploitable code). Still, `/conformance/coverage*` are
  **owner-Bearer + `X-Instar-Request: 1` intent-gated** (the per-handler pattern used
  by other sensitive routes) and mounted so they are not part of the public capability
  surface. (We deliberately do NOT claim PIN-scope exclusion — round-2 verification
  confirmed the dashboard PIN unlock returns the same bearer token, so that primitive
  does not exist; the honest control is the intent header + owner-Bearer.)

## Concurrency / multi-machine

- The audit is deterministic and idempotent, so cross-machine divergence is
  impossible from the same registry+repo. The job is lease-gated for single-writer
  tidiness; the read route serves the local `state/standards-coverage.json` (identical
  across machines on the same commit). No proxy needed.

## Migration & Deployment / Agent Awareness

- **Config:** `cartographer.conformanceAudit` nested under `cartographer` (deep-merge
  backfill): `{ enabled:false, llmEnrichment:{ enabled:false, egressAcknowledged:false,
  framework, allowClaudeFallback:false }, ratchetFloor }`. Dark behind
  `cartographer.enabled` AND `conformanceAudit.enabled`.
- **Job:** ship `standards-coverage-audit` as a built-in job template (off by default),
  same install path as other instar jobs.
- **CapabilityIndex:** register the `/conformance/coverage*` read routes.
- **CLAUDE.md (Agent Awareness) — BOTH paths** (`generateClaudeMd` + `migrateClaudeMd`,
  own marker, idempotent): a section — what the coverage audit is, the read routes,
  "a gap is a guard worth building, surfaced not auto-fixed."
- **componentCategories:** register `StandardsCoverageEnrichment` under category `job`
  (only used by the dark LLM-enrichment path) + a wiring test.
- **Rollback:** disabling `conformanceAudit.enabled` makes the routes 503 + stops the
  job; `state/standards-coverage.json` goes inert. No migration reversal.
- **Bounded Notification Surface:** the job raises ONE aggregated item only on gap
  GROWTH; a burst test enforces it.
- **Dogfood-to-ship (Self-Hosting):** this audit is itself a shippable user capability
  — a user's agent gets "which of MY constitutional standards are actually guarded?"
  for free. Stated to satisfy the standard it measures.

## Test plan (3 tiers)

- **Tier 1 (unit):**
  - **extraction**: a fixture registry article naming `tests/unit/x.test.ts` +
    `GET /foo` + `B16_MARKER` → the extractor pulls exactly those refs; bare prose with
    no enforcement shape → zero refs; a `#123` is provenance, not a guard.
  - **verification + classification**: a ref that exists → `verified:true` + the right
    `enforcementKind` (ratchet > gate > lint > spec-only > documented-only by
    strength); a ref that does NOT exist → `danglingRefs` (the loud signal); a standard
    with no enforcement ref → `documented-only` gap.
  - **determinism/idempotency**: two runs over the same fixture registry+repo yield
    byte-identical reports; the content-hash short-circuit skips recompute.
  - **the real registry**: a canary asserts the audit parses the LIVE
    `docs/STANDARDS-REGISTRY.md` and classifies a KNOWN-enforced standard ("No Silent
    Degradation" → its `no-silent-llm-fallback.test.ts` ratchet verifies) and that the
    enforced ratio is within a sane band (catches a parser break).
  - **CI ratchet script**: enforced-ratio floor fails on a synthetic regression; a
    synthetic dangling ref fails the zero-dangling ceiling; the floor is the committed
    constant; output file is never the floor.
- **Tier 2 (integration/HTTP):** `GET /conformance/coverage` + `/coverage/health` →
  200 with the documented shape + filters when enabled; 503 disabled; 401 no bearer;
  the intent-header gate enforced.
- **Tier 3 (E2E "alive"):** with the feature enabled, `GET /conformance/coverage/health`
  computes over the REAL registry + repo and returns a real enforced ratio + a real
  (possibly empty) gap list + zero dangling refs on a clean checkout; a fixture with a
  planted dangling ref surfaces it. Proves the audit is wired to the real registry +
  real fs, not a no-op — and unlike the rejected designs, it produces REAL, non-empty
  output on day one (the coverage of the actual ~30 standards).

## Open questions (resolved by decision)

- **(Resolved — decided)** Deterministic-first; the LLM enrichment is optional, dark,
  advisory. The value is the deterministic coverage map.
- **(Resolved — decided)** Job (cheap, on-demand + slow cadence), not an expensive
  poller — the pass is milliseconds.
- **(Resolved — out of scope)** Auto-building the missing guards, gating on a gap, a
  dashboard tab — not owed by this spec; the gap list is the actionable output.
