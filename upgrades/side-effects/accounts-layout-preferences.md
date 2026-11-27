# Accounts grouping and sorting

## Summary

Tier 1. The dashboard organizes the existing Accounts view by provider, machine, or no grouping. Defaults are provider and soonest weekly reset. The browser validates and remembers each choice locally.

## Signal and authority

The layout reads the existing account and machine details. It preserves the same sign-in actions and access checks. Machine groups contain only recorded account slots, with the detail sheet scoped to the chosen slot. Missing slots remain accessible in the provider or ungrouped account details. A host-wide active-account badge is hidden in machine view because the host signal alone does not identify the group machine.

## Interactions

The controls rearrange the loaded list without a network read. The quota forecast, sign-in notices, and totals continue to receive the original account collection. Unknown measurements sort after known measurements, and name and stable identity break ties. If browser storage is unavailable, the choices still work in memory. Separate browsers and Mac app instances keep their own settings.

## Rollback

Revert the dashboard changes. The unused browser preference key can remain without affecting account state or actions.

## Independent review

Concur with the review. Reviewer `/root/accounts_layout_review` verified provider defaults, sorting, preferences, real machine slots, and existing action paths. The reviewer identified the active-account badge ambiguity, which is addressed by hiding it in machine groups.

## Evidence

On main base `3e318c923`, 63 renderer and model tests, 17 HTTP integration tests, two production lifecycle tests, and six disposable browser cases passed. The browser cases covered light and dark themes at 320, 390 and 1280 pixels, saved preferences, and 44-pixel controls.
