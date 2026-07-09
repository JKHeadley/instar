# Dashboard responsive fix — plain-English overview

## What this actually is

The operator opened the dashboard on a desktop browser and found every newer tab — Routing Map, Spend, Tokens, LLM Activity, and ten others — crammed into a narrow strip on the far left of the screen, with the rest of the window empty black. On a 1280-pixel-wide window, all the content lived in about 185 pixels. His words: "everything is squished to the side."

This change fixes that, and — more importantly — makes it impossible for the bug to quietly come back.

## Why it happened

The dashboard page lays itself out as a grid with two columns: a 280px sidebar on the left and the main content area on the right. Most tab panels were added to the page *after* the main content area's closing tag, which makes each of them a direct member of that grid. When you switch to such a tab, the page hides the sidebar — and a grid member with no explicit "where do I go" instruction gets auto-placed into the first column. That first column is the 280px sidebar column. So the whole tab renders inside a sidebar-width strip.

Here's the telling part: this exact trap was already known. The Process Health tab hit it months ago, and its fix carries a CSS comment explaining the bug and the cure ("span the full grid"). But a comment is a wish, not a rule — every one of the fourteen panels added since then repeated the bug, because nothing checked.

## What's new

1. **One shared rule.** A `tab-panel` style class now carries the correct grid placement ("span all columns"), and all fourteen affected panels use it. One rule, one place, instead of fourteen copies of an inline fix.

2. **A guard test.** A new unit test reads the dashboard page and fails the build if any tab panel after the main area lacks a placement-carrying class. The test's failure message tells the author exactly what to add. This converts the old CSS comment from a wish into a guarantee — a future tab that repeats the bug cannot pass CI. The test was proven both ways: it passes on the fixed page, and deliberately removing one panel's class makes it fail with the right message naming the right panel.

## Verified how

Before/after screenshots were rendered in a real browser engine at desktop width (1280px) and phone width (390px). Before: content in a ~260px strip. After: full-width layout with the header intact. The phone rendering is byte-identical before and after this change — the fix is placement-only and touches nothing else.

## What this does NOT do

It does not redesign the dashboard, change any data, alter any behavior of the server, or touch any decision-making code. It is presentation-layer only. The operator's larger ask — a high, enforced usability standard for every dashboard feature — is a separate piece of work with its own spec and review cycle (tracked in the working brief for topic 29723); this is deliberately the minimal structural fix for the reported bug.

## What you need to decide

Nothing — this is a bug fix the operator explicitly requested ("at the very minimum make sure the views/elements are properly responsive"). It ships dark of nothing; the fix is visible the moment the release reaches a machine.
