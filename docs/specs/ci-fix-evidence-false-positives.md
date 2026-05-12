---
slug: ci-fix-evidence-false-positives
title: Tighten FIX_PATTERNS in upgrade-guide-validator to fix false positives
review-convergence: "converged"
approved: true
risk: low
---

# Tighten FIX_PATTERNS in upgrade-guide-validator to fix false positives

## Problem

The publish CI is blocked on every PR by a false "no Evidence section" error.
The `claimsFix()` function in `upgrade-guide-validator.mjs` uses word-presence
patterns that match legitimate technical prose:

- `\bbroken\b` matches "while a child is broken" (runtime state input)
- `\bcrashed\b` matches "a crashed runner" (adjective)
- `\bresolves?\b` matches "items resolve" and `resolve-conflict` (API action verb)

None of these are bug fix claims, but the validator treats them as such and
requires an Evidence section that doesn't belong in a feature release guide.

## Solution

Tighten the three over-broad patterns:

1. Remove `\bcrashed\b` — crash verb forms (`crashes?`, `crashing`) remain.
   Any genuine crash-fix guide would also use "fix/fixed" which is caught.

2. Tighten `\bbroken\b` → `\b(?:was|were)\s+broken\b` — only the predicate
   form triggers, not attributive adjective uses.

3. Tighten `\bresolves?\b` → `\bresolves?\s+(?:an?\b|the\b)/i` — only
   "resolves a/an/the <defect>" triggers. Bare "resolve" and hyphenated
   action verbs ("resolve-conflict") do not.

## Verification

- 24 unit tests pass, including 3 new regression tests for the exact
  false-positive cases.
- 1294 tests pass across all upgrade-guide test files.
- `check-upgrade-guide.js` passes against the previously-blocking NEXT.md.

## Risk assessment

Low. Change makes the validator more permissive (reduces false positives).
Under-block risk is minimal: any genuine crash/broken fix also uses
"fix/fixed/resolves a/the" which still trigger. See side-effects review at
`upgrades/side-effects/NEXT.md` for full analysis.
