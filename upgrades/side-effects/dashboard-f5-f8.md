# Side-effects review — Dashboard UX Standard floors F5–F8

**Change:** `dashboard/index.html` (F5 button labels, F6 empty-state de-jargoning, F7 canonical-class doc) + three static floor tests (`dashboard-controls-labeled` F5, `dashboard-empty-states` F6, `dashboard-assets-resolve` F8). Spec: `docs/specs/dashboard-ux-standard.md` (converged + approved, shipped in #1404). Tier 1 — display-only markup + build-time CI floors; no runtime `src/` change, no decision logic.

## Phase 1 — Principle check (signal vs authority)
Does this touch a decision point that gates information flow / blocks actions / constrains agent behavior? **No.** The changes are (a) HTML label/text attributes rendered to the operator and (b) static test files that fail a *build* if the dashboard regresses. The tests are build-time CI floors, not runtime authorities — they never gate a message, session, or agent action. Signal-vs-authority does not apply (no runtime decision surface).

## Phase 4 — Side-effects review
1. **Over-block:** the floor tests could reject legitimate markup. F5 accepts a button labeled by visible text OR `title` OR `aria-label` OR dynamic (`${…}`/concatenated) content — the full current button population passes; a button labeled *only* by an adjacent element (not itself) would false-flag, acceptable because self-labeling is the accessibility norm and easily satisfied. F6 requires a ≥4-word sentence in each `*Empty*` container — a legitimately terse state would flag, but the 4-word floor is lenient. F8 excludes `data:`/`http(s)`/dynamic `${}` srcs, so only real static local refs are checked. No legitimate current markup is rejected (all 7 dashboard tests green).
2. **Under-block:** F5 checks `<button>` only, not `<select>`/`<input>` labeling (a tracked F5 follow-up <!-- tracked: topic-29723 -->). F6 audits `*Empty*`-id containers, not every conceivable resting state. F8 checks static local refs only. These are honest partial floors that raise the bar without claiming totality — not regressions.
3. **Level-of-abstraction fit:** correct layer. A UI-consistency standard is enforced at build time over the shipped markup; there is no smarter runtime gate this should feed (it is not a runtime concern). It extends the existing dashboard-floor test family (`dashboard-tab-purpose`, `dashboard-panel-placement`, `dashboard-nav-reachability`, `dashboard-viewport-scroll`) — same pattern, same layer.
4. **Signal vs authority compliance:** compliant by absence — no blocking authority added (build-time test, not runtime gate). See Phase 1.
5. **Interactions:** the new F5/F6/F8 tests are independent scans over `index.html`; none shadows another. The F7 change is a CSS *comment* only — it does not alter the `.tab-purpose` rule and the F3 `dashboard-tab-purpose` test (which recognizes all four purpose-line classes) still passes. No double-fire, no race with cleanup.
6. **External surfaces:** changes the dashboard HTML the operator sees — 4 icon buttons gain accessible names, 2 empty states lose API jargon ("POST /projects" → plain language). Strictly additive/clarifying; no behavior, endpoint, or data change. No surface visible to other agents/users/systems. No timing/conversation-state dependency.
7. **Multi-machine posture:** **machine-local BY DESIGN** — `dashboard/index.html` is a static asset shipped in the package and served by each machine's own server; every machine serves the identical shipped file, so there is nothing to replicate, proxy, or transfer. No durable state, no generated URL, no user-facing notice. A single-machine assumption is correct here, not a defect.
8. **Rollback cost:** trivial — `git revert` the commit. Display-only markup + additive tests; no migration, no agent-state repair, no data change.

## Phase 4.5 — No deferrals
The two under-block follow-ups (F5 select/input labeling; broader F6 coverage) are tracked <!-- tracked: topic-29723 -->. F7 hard-consolidation is deliberately soft-first per the spec's FD-3, not an orphan deferral. No partial fix of an in-scope item is shipped.

## Phase 5 — Second pass
Not required: no block/allow, session-lifecycle, coherence, or sentinel/guard/gate/watchdog surface (Tier 1, display-only).
