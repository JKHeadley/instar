# Side-Effects Review — Process Health tab ELI16 + structure pass

**Version / slug:** `process-health-tab-eli16-pass`
**Date:** 2026-05-27
**Author:** echo
**Spec:** `docs/specs/PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md` (v4, the original feature spec; this PR is a UX-refinement follow-up that does NOT change the spec's behavioral surface)

## Summary of the change

Eight rounds of user-driven copy + UX iteration on the Process Health dashboard tab (originally shipped in v1.3.27 via PR #435). Pure dashboard-only refinement — no `src/` / `scripts/` / `.husky/` / `skills/` changes — so this PR is outside the instar-dev gate's in-scope set. The reference implementation now backs a durable agent memory (`feedback_dashboard_copy_eli16.md`) that codifies the **Dashboard Standard** for future dashboard features.

**Files changed (UI):**
- `dashboard/process-health.js` (renderers): rewritten `CATEGORY_WORDS`, `ATTRIBUTION_LABELS`, `STAGES`, `INSIGHT_STATUS_WORDS`; new `TYPE_WORDS`, `STATUS_WORDS`, `CAUSE_CONFIDENCE_WORDS`, `statusDotClass`, `statusDot`, `labeledRow`. Restructured `renderCaptured` and `renderPatterns` around the fixed label vocabulary + `<details>` expandability + status color dots. `renderMaturation` reshaped per-stage as expandable `<details>` with plain-English descriptions. Dropped the redundant per-card framing line in v7.
- `dashboard/index.html`: added page-intro paragraph + per-section subtitles that distinguish each section and cross-reference adjacent ones; new CSS for `.ph-intro`, `.ph-h-sub`, `.ph-item`, `.ph-item-summary`, `.ph-item-text`, `.ph-item-body`, `.ph-item-row`, `.ph-label`, `.ph-value`, `.ph-status-dot` (+ 5 status-color variants), `.ph-stage-summary`, `.ph-stage-body`; chevron disclosure indicator on every `<details>` (opacity 0.8).

**Files changed (tests):**
- `tests/unit/process-health-render.test.ts`: assertions rewritten for new label vocabulary + new status copy + new framing absence + structural assertions on `<details>` + status-dot CSS classes (3 new structural tests added).
- `tests/integration/process-health-tab.test.ts`: assertions updated for new copy; new framing-absence check.
- `tests/e2e/process-health-tab-lifecycle.test.ts`: assertions updated for new copy.

**Files changed (release):**
- `upgrades/NEXT.md` (NEW for this PR, `bump: patch`).

## Decision-point inventory

- **Pure UX refinement vs. functional change?** Pure UX. No new endpoints, no new data fields, no new auth surfaces, no behavioral changes to the polling controller, no changes to the route layer, no changes to migration parity. Only the rendered text + DOM structure changes.
- **Drop the recommendation field entirely vs. keep + relabel?** Dropped. Justin explicitly directed "avoid language that implies user needs to act unless ABSOLUTELY essential". The recommendation field is upstream prose that is action-implying by content; relabeling chrome around it doesn't change that. Actionable insight delivery is the deferred §10 surface anyway; v1 of the tab is the calm informational surface.
- **Drop the per-card framing line vs. keep + rephrase?** Dropped in v7. Once "verify before acting" was rephrased to "Same kind of problem has come up more than once" in v5, it became the third echo of the section title + section subtitle. The no-action-authority signal that the framing was originally carrying is now structural (the rendered card has nothing actionable on it), not chrome.
- **Add status color dots vs. status text only?** Dots. Lets the user scan the collapsed list and read state at a glance without expanding each item. Colors are calm (amber/blue/green/gray) — never alarm reds, per the existing visual rules.

## Side-effects analysis

- **Behavioral:** None. The polling controller, route layer, and migration paths are unchanged. Only the rendered DOM differs.
- **Architectural:** None. Same file structure; the renderer module is the same self-contained ESM as before. No new build step, no new runtime dependency.
- **Security:** The safety contract (`sanitizeForDisplay`, textContent-only DOM writes, element ban, safeUrl) is unchanged. New label spans (`.ph-label`, `.ph-value`) use textContent only. The XSS negative fixture continues to fire zero live elements + no canary. The `detail.full` redaction is unchanged.
- **Migration parity:** Not applicable — no agent-installed-file changes (`templates.ts` / `PostUpdateMigrator` / shadow markers untouched).
- **Performance:** Marginal increase in DOM nodes per item (each captured item now has 4–5 `<div>`s of body content instead of 0–4 flat children). Diff-aware rendering still works (signature mechanism is structure-agnostic). No new fetches.
- **Reversibility:** Fully reversible — revert the commit and the previous render returns.

## Standard captured (the durable artifact this PR exists to back)

The 8-round iteration converged on a design that's now codified as the **Dashboard Standard** in `feedback_dashboard_copy_eli16.md` (agent memory): 7 rules (ELI16 copy + codename maps + grounding intro + self-contained section titles with subtitles + expandable items + fixed label vocabulary + no action-implying language), 8 default substitutions, 4 calm status-color tokens, and the show-don't-tell iteration pattern. The Process Health tab is now the reference implementation.

## Evidence pointers

- All 46 tests green: 30 unit + 12 integration + 4 e2e — includes structural assertions for the unified label order, status-dot CSS classes, and that the dropped framing line is genuinely absent.
- Safety verified end-to-end: XSS negative fixture still fires zero live elements + no canary; `detail.full` redaction unchanged.
- Typecheck: `tsc --noEmit` clean.
- Live-rendered both views (collapsed + expanded) to Chrome headless across 8 iterations and sent screenshots to the user for thumbs-up before each commit. Justin approved v8 with "this is good enough, let's go with it; save this as the standard for future dashboard features".
