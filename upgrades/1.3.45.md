# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

UX refinement of the Process Health dashboard tab shipped in v1.3.27. Eight rounds of user-driven copy + structure iteration landed on the design that became the **Dashboard Standard** — the bar all future dashboard features now start from. Pure dashboard-only change (`dashboard/process-health.js` + `dashboard/index.html` + tests); no `src/` / `scripts/` / `.husky/` / `skills/` changes.

What the page looks like now: a one-sentence intro grounds the subject so "it" later in the page has a referent; each section title carries a one-line subtitle that distinguishes it from the others (with explicit cross-references — "When the same kind keeps repeating, it shows up as a pattern above"); each captured problem and pattern card is a `<details>` element with a status color dot on the left (amber/blue/green/gray — never alarm reds) and a chevron on the right; the expanded body is a labeled fact-sheet using a fixed vocabulary (Status / Where / Times seen / First noticed / Cause) used identically across both lists. All action-implying language ("Suggested next step", "verify before acting", "Fix worked") is gone — the page informs, it doesn't direct. Internal codenames (`capture-only`, `failure-learning-loop`, `config-parse`) never reach the DOM; they pass through renderer-owned plain-English maps.

The reference implementation now backs a durable agent memory (`feedback_dashboard_copy_eli16.md`) that codifies the seven rules + eight default substitutions + four status-color tokens so future dashboard work starts from this bar.

## What to Tell Your User

- The Process Health tab on your dashboard reads a lot more clearly now: a calm intro tells you what the page is showing in one sentence, every problem and pattern collapses to one plain line with a small color dot (amber = still being looked into, blue = cause known, green = worked out, gray = closed), and tapping any row opens up the same set of labeled details — Status, Where, Times seen, First noticed, Cause — every time. The bar this set for "what a calm, informative dashboard reads like" is now the standard for everything I build next.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Process Health tab — ELI16 + structure pass | Open the Process Health tab in your dashboard (no action needed; it’s just clearer now) |
| Dashboard Standard (durable, applies to future dashboard work) | Reference: `feedback_dashboard_copy_eli16.md` (in agent memory) — 7 rules + 8 substitutions + 4 status-color tokens |

## Evidence

- 46 tests green: 30 unit + 12 integration + 4 e2e — includes structural assertions for the unified label order, status-dot CSS classes, and that the dropped framing line is genuinely absent.
- Safety contract unchanged: XSS negative fixture still fires zero live elements + no canary; `detail.full` redaction is verified end-to-end.
- Show-don't-tell iteration: eight rounds, each rendered to a real browser and screenshotted for user thumbs-up before committing — no merge-and-iterate churn. The harness pattern is captured in the standard.
