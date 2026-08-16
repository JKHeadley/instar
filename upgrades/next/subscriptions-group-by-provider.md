# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Subscriptions tab now groups your accounts by provider — Claude accounts together, Codex
accounts together, each under a heading.

Before, the list was one flat run of cards in enrolment order, so a Codex account could sit
between two Claude ones. Each card names its provider, but in small text partway down, so
telling them apart meant reading every card. With a single provider that was fine. With two it
stopped being fine.

The quota bars live inside the account cards, so grouping the accounts groups the quota view
along with them.

## What to Tell Your User

- "Your accounts list is grouped by provider now, so your Codex account no longer sits in the
  middle of your Claude ones."
- "If you only have one provider, nothing changes at all."

## Summary of New Capabilities

None. This is a presentation change to an existing tab — no endpoint, no configuration.

## Compatibility Notes

**A single-provider install is untouched**: with one provider no heading is drawn, and the list
renders exactly as before. That is deliberate — a heading reading "Claude" above a list of only
Claude accounts is noise — and it is pinned by a test.

Accounts keep their existing order within each group. Nothing is sorted alphabetically, because
the order accounts arrive in carries meaning the dashboard cannot see (which was enrolled first,
which is the default). The change re-associates without re-ranking.

An account with no provider is still shown, under a heading reading "Other", rather than being
dropped or filed under a provider it does not belong to.

## Evidence

8 tests in the existing jsdom suite, which exercises the shipped dashboard module against a real
DOM. Shown capable of failing: restoring the flat list fails exactly the four grouping
assertions while the four invariant tests keep passing.

The controls carry the weight — a single-provider list is asserted unchanged, and order within a
group is asserted preserved. Without them, "grouping works" would pass equally well against a
change that sorted everything alphabetically and added a redundant heading to every
single-provider install.

The heading is the one new dynamic string reaching the page, so it rides the tab's existing
sanitize-and-write-as-text contract; a test plants a hostile provider string and confirms no
live element and no event-handler attribute survives.
