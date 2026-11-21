# A crafted pattern on the degradations route can no longer freeze the server

<!-- bump: patch -->

## What Changed

SEC-125. `POST /health/degradations/mark-reported` turned a caller's `featurePattern` into a full regular expression with no limit and ran it over every stored feature name. A nested-repeat pattern could block the server for minutes or hours. Patterns are now limited to 128 characters of letters, digits, `_ - .`, `\.`, `^`, `$` and `|`, which can always be matched quickly. Anything else is answered 400. Marking by exact `feature` name is unchanged.

## What to Tell Your User

- **Health check can't be used to freeze me**: "One of my internal maintenance requests could be given a pattern that locked me up until I restarted. It now only accepts simple patterns."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Safe feature patterns on mark-reported | Automatic |

## Evidence

- `tests/unit/routes-degradations-mark-reported.test.ts`: prefix, suffix and alternation patterns still match; nested-quantifier, repeat, class, escape and lookahead patterns are refused; over-long patterns are refused; a worst-case allowed pattern on a 5000-character name finishes well under 500 ms; a source check fails if the route goes back to `new RegExp` on caller input (it fails on the old route).
