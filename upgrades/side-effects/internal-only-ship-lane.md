# Side-Effects Review — internal-only release-note lane (mechanism)

**Version / slug:** `internal-only-ship-lane`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `required (release-critical CI machinery)`

## Summary of the change

Every release-note fragment currently must carry all four sections — including the
two user-facing ones (**What to Tell Your User**, **Summary of New Capabilities**).
For a change with NO user-facing surface (test-only, docs-only, build/CI scripts with
no `src/` runtime change) that copy is pure boilerplate ("None — internal"), which is
disproportionate ceremony (the codex-#25 friction; the #758 telegraph test-flake fix
had to hand-write two "None — internal" sections).

This adds an **internal-only lane** (operator-approved). A fragment opts in with an
`<!-- internal-only -->` marker and may OMIT the two user-facing sections. The
assembler auto-fills them with a canonical "None — internal change…" ONLY when
*every* contributing fragment is internal-only. The objective gate: the pre-push gate
verifies the marker against the diff — an internal-only fragment whose change touches
runtime `src/` is REJECTED. Side-effects review + decision-trace are unchanged — safety
and auditability never get a lighter lane.

This PR is the **mechanism** (assembler + pre-push verification + tests). The
deployed-skill documentation (`skills/instar-dev/SKILL.md` + a PostUpdateMigrator
migration to redeploy it) is a tracked follow-up.

## Decision-point inventory

1. **assembler auto-fill** (`assembleNextMd`): when `allInternal` (every fragment
   marked) and a user-facing canonical section is missing from the merged map, inject
   `INTERNAL_ONLY_FILL`. Never auto-fills when any fragment is non-internal.
2. **pre-push verification** (`pre-push-gate.js` §3c): an internal-only fragment +
   any `src/*.ts` change in the diff → error.

## 1. Over-block (what still fails / is required)

- A genuinely user-facing change that OMITS the user sections still fails: it is not
  `allInternal` (it has no marker, or the gate rejects the marker on a `src/` diff), so
  the assembler does NOT auto-fill, and `validateGuideContent` reports the missing
  sections. (test: "does NOT auto-fill when any fragment is user-facing".)
- `What Changed` + `Evidence` are still required; the Evidence-bar (fix-claim →
  Evidence) is untouched.
- All existing fragment validations (inline-code / camelCase / fenced-block leakage,
  malformed fragment, bump tier) are unchanged — 25 pre-existing assembler tests +
  the full pre-push suite stay green.

## 2. Under-block (what it now allows)

- An all-internal release may omit the two user-facing sections; the assembler fills
  them. This is gated objectively: the marker is verified against the diff at pre-push,
  so it cannot be set on a runtime `src/` change to hide user-facing impact. The agent
  sets the marker; the diff verifies it. (test: source-presence of the §3c gate +
  `hasInternalOnlyMarker`.)
- Worst case of a wrong marker on a non-src change (e.g. a scripts change that DOES have
  user impact): the publish notes say "None — internal" for that release. Bounded and
  low-harm — scripts/docs/test changes have no agent-user runtime surface by
  construction.

## 3. Blast radius

- `scripts/assemble-next-md.mjs` — pure function; new `hasInternalOnlyMarker` +
  `INTERNAL_ONLY_FILL` exports + the auto-fill branch.
- `scripts/pre-push-gate.js` — one new §3c check (reuses existing `srcChanges` /
  `fragmentChanges`).
- Tests only otherwise. NO `src/` change, no runtime/agent surface. The assembler is
  shared by BOTH the pre-push gate and the publish gate (`check-upgrade-guide.js`), so
  the auto-fill keeps both consistent — the change was deliberately placed in the shared
  assembler so the two gates can never disagree.

## 4. Reversibility

Fully reversible: revert the two scripts + test edits. No state, no persisted format
(the `<!-- internal-only -->` marker is just a fragment comment — a fragment without it
behaves exactly as before). Verified: 45 tests green (assemble-next-md + pre-push-gate
suites), `node --check` clean on the gate.
