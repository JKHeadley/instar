# Side-Effects Review — Operator-Surface Quality standard + Mandates-tab redesign

**Version / slug:** `operator-surface-quality-and-mandates-redesign`
**Date:** `2026-06-12`
**Author:** `Echo (instar dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Two cohesive changes from one operator finding (2026-06-12, topic 22367, CMT-1434):
the freshly-shipped Mandates grant form was mobile-*reachable* (per Mobile-Complete
Operator Actions) yet unusable ("abysmal"). This (A) redesigns the Mandates
dashboard card to be genuinely good, and (B) lands a new constitutional standard,
**Operator-Surface Quality**, with a real enforcement gate so reachable-but-bad
cannot ship again.

Files touched:
- `dashboard/mandates.js` — renderers: grant form is now the card's primary,
  always-open block (was wrapped in a collapsed `<details>`); revoke demoted to a
  quiet collapsed control ordered after grant; JSON bounds / fingerprints / scope
  slugs replaced by a plain-language summary, with ids kept only on a muted "For
  support" line; grants list humanized; audit cells carry `data-label` for
  mobile stacking.
- `dashboard/index.html` — shortened the explanatory wall to one line + a
  collapsible "What is this?"; added CSS for the primary grant block, the demoted
  revoke, the plain summary, and a `@media (max-width:640px)` rule that stacks the
  audit table so the reason column is never truncated.
- `docs/STANDARDS-REGISTRY.md` — new "Operator-Surface Quality" article (Interaction
  family), naming `scripts/instar-dev-precommit.js` as its gate.
- `skills/instar-dev/templates/side-effects-artifact.md` — new §6b operator-surface
  quality question.
- `scripts/instar-dev-precommit.js` + `scripts/lib/operator-surface.mjs` — the gate
  (`assertOperatorSurfaceQuality`) + its pure decision predicates.
- Tests: `tests/unit/dashboard-mandateGrantForm.test.ts`,
  `tests/unit/dashboard-mandatesTab.test.ts`,
  `tests/unit/standards-enforcement-auditor.test.ts`,
  `tests/unit/operator-surface-gate.test.ts`.

## Decision-point inventory

- `assertOperatorSurfaceQuality` (scripts/instar-dev-precommit.js) — **add** — a new
  scoped review gate: when a commit touches an operator surface, the side-effects
  artifact must answer the operator-surface-quality question or the commit blocks.
- `isOperatorSurfaceFile` / `artifactAddressesOperatorSurfaceQuality`
  (scripts/lib/operator-surface.mjs) — **add** — the gate's two pure predicates.
- Mandates renderers (dashboard/mandates.js) — **modify** — presentation only; no
  change to the grant/revoke/issue API calls, payloads, or PIN discipline.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only block/allow surface added is the pre-commit gate. It fires ONLY when a
staged file matches an operator surface (`dashboard/*.js|html`, or an
approval/secret-drop/operator-approval form) AND the side-effects artifact lacks
the operator-surface-quality phrase. A legitimate operator-surface change whose
review genuinely answers §6b passes. A change touching no operator surface is never
evaluated. The detector explicitly excludes `*.test.*`/`*.spec.*` siblings so a
test guarding a surface isn't itself treated as the surface.

## 2. Under-block

**What failure modes does this still miss?**

A commit that touches an operator surface but stages NO in-scope file (src/,
scripts/, .husky/, skill) never reaches the gate at all — the precommit only runs
its body when an in-scope file is staged. This is the SAME boundary the sibling
`assertFrameworkGenerality` gate has (it fires only when its src surface is
touched). A pure dashboard-only commit (dashboard/ is not in-scope) would not be
gated. Accepted for v1: the dashboard surface is authored by instar-dev work that
near-always co-stages an in-scope file, and the standard + template question still
guide the review. Widening the gate's trigger to operator surfaces directly is a
tracked follow-up, not silently dropped.

The gate also checks for *presence* of the §6b engagement, not the substantive
quality of the four answers — that judgment stays with the reviewer (Signal vs.
Authority: the gate signals the question must be present; the mind answers it).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The gate is a brittle path/text detector that ENFORCES a written answer; it
holds no semantic judgment about whether the UI is actually good — that is the
reviewer's call. This is the correct split: the detector ensures the question is
asked; the full-context mind answers it. It feeds the existing side-effects review
flow rather than running parallel to it, mirroring `assertFrameworkGenerality`.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface that makes a *semantic* judgment.
  The gate's only authority is "the operator-surface-quality section must be present
  in the artifact for an operator-surface change" — a structural presence check, not
  a content-quality verdict. The quality verdict stays with the human/agent reviewer.

## 5. Interactions

- **Shadowing:** the new gate runs alongside `assertFrameworkGenerality` at both the
  Tier-1 and Tier-2 pass sites; neither shadows the other (different surfaces,
  different artifacts checks). Both run before `process.exit(0)`.
- **Double-fire:** the gate is invoked once per pass path; only one pass path
  executes per commit (Tier-1 lite exits, Tier-2 falls through). No double-fire.
- **Races:** none — pure synchronous file reads at commit time.
- **Feedback loops:** none.

The dashboard renderer changes are pure presentation: the grant/revoke/issue
controller, fetch calls, payloads, and PIN-never-retained discipline are untouched
(verified — all existing controller tests pass unchanged).

## 6. External surfaces

- Other agents on the same machine? No.
- Other users of the install base? Yes — the Mandates dashboard tab is the visible
  change. It ships via the package's `dashboard/` (served by `express.static`), so
  it reaches every agent through the normal release → auto-update path. No
  agent-installed-file rewrite is involved for the dashboard.
- External systems? No.
- Persistent state? No.
- **Operator surface (Mobile-Complete Operator Actions):** the Mandates grant/revoke
  actions already have a phone-completable surface (this very tab). This change
  improves that surface; it adds no new API-only operator action.

**Migration parity (the one agent-installed file I touched —
`skills/instar-dev/templates/side-effects-artifact.md`):** this template is deployed
into dev-agent homes and is already migrated by
`migrateMultiMachinePostureReviewDimension`. I deliberately did NOT add a new
`PostUpdateMigrator` migration, and this is a recorded decision, not a silent skip:
(1) the BINDING enforcement is the pre-commit gate in `scripts/`, which is
instar-source-repo tooling run from `.husky` — it is NOT a deployed runtime file and
works for ALL instar-dev work regardless of any installed template copy; (2) the gate
is self-teaching — its block message names the exact §6b section to add, so no
developer is left in a silent-fail state (the Migration Parity standard's actual
concern: "a feature that only works for new agents"); (3) new agents get §6b via
`installBuiltinSkills`; existing agents NOT yet on the multi-machine template get it
automatically because the bundled file the existing migration re-copies now contains
§6b; only an already-multi-machine dev agent misses the template PROMPT, and the gate
covers it. Touching `PostUpdateMigrator` (fleet machinery the codebase declares
"never Tier-1") to ship a convenience prompt to that narrow residual is
disproportionate. Tracked: CMT-1434.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The change is a stateless dashboard renderer + a
commit-time repo gate. The dashboard reads pool-wide mandate/audit state from the
server it is served by (no new per-machine state); the gate runs in whichever
checkout the developer commits from. It emits no user-facing notices, holds no
durable state, and generates no URLs — so there is nothing to replicate, proxy, or
strand on a topic transfer. Framework generality: not applicable — this touches
neither the session launch/inject abstraction nor messaging delivery.

## 8. Rollback cost

Pure code change. Revert the renderer/markup/CSS and the gate; ship as a patch. No
persistent state, no data migration, no agent-state repair. During the rollback
window users would simply see the prior Mandates card again — no functional
regression (the underlying mandate API is unchanged throughout).

## Conclusion

The review produced one design refinement: extracting the gate's decision logic into
a pure, unit-tested lib (`scripts/lib/operator-surface.mjs`) rather than inlining
regexes in the precommit, so both sides of each boundary are pinned by tests and the
gate's wiring is verifiable. The recorded migration-parity decision (no new
`PostUpdateMigrator` migration, with explicit reasoning) is the one item flagged for
the operator's awareness. Clear to ship as a Tier-1 change.

## Operator-surface quality (Operator-Surface Quality standard) — §6b self-review

This change IS an operator surface (`dashboard/mandates.js`, `dashboard/index.html`),
so it is held to the standard it introduces:

1. **Leads with the primary action?** Yes. The Grant form renders as an open,
   titled `mnd-grant-block` — never inside a collapsed `<details>`. On a mandate
   with no grants it is the visible call to action.
2. **Zero raw internals as primary content?** Yes. The card headline is a
   de-slugified scope title; the body is a plain-language summary. No JSON bounds,
   no fingerprints, no slugs as primary content (asserted: the card body contains no
   `{"` substring and no raw bounds keys). Ids/fingerprints/slugs survive only on a
   muted "For support" line.
3. **Destructive actions de-emphasized?** Yes. Revoke is a quiet, collapsed
   `mnd-revoke-details` ordered AFTER the Grant block in the DOM; the danger button
   is no longer bold/featured (asserted: grant index < revoke index).
4. **Plain language + phone width?** Yes. Grants read "Adam Admin can deploy to
   production until … — authorized by you"; action slugs are humanized; the audit
   table stacks into labelled rows at ≤640px so the reason column is never
   truncated.

## Evidence pointers

- `tests/unit/dashboard-mandateGrantForm.test.ts` — grant form NOT in collapsed
  `<details>`; no `{"` JSON in card body; revoke ordered after grant; humanized
  grants; mobile audit labels.
- `tests/unit/operator-surface-gate.test.ts` — both predicates (both sides of each
  boundary) + wiring-integrity (the gate is called on both pass paths, not a no-op).
- `tests/unit/standards-enforcement-auditor.test.ts` — the new standard classifies as
  `gate` with zero dangling refs over the real registry.
