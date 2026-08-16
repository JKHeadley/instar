# Side-Effects Review — group the accounts list by provider

## Summary

`renderAccounts` drew accounts in a flat pool-ordered run, interleaving providers. It now draws
each provider's accounts together under a heading, via a new pure `groupAccountsByProvider`.

## Decision-point inventory

None. This is presentation ordering. It gates nothing, grants nothing, and reads no state
beyond the accounts array it is already handed.

## 1. Over-block / 2. Under-block

Not applicable — no admission decision. The nearest analogue is dropping an account from the
list, which a test forbids explicitly (every account renders exactly once; count asserted).

## 3. Level-of-abstraction fit

Grouping belongs in the renderer, not the API. The pool's order is meaningful and the server
should keep returning it as-is; how it is PRESENTED is a dashboard concern. Sorting server-side
would have imposed one view on every consumer.

## 4. Signal vs authority

Not applicable — no decision logic.

## 5. Interactions

The in-use marker, quota bars, status, email and the no-quota fallback all render through the
unchanged card path; grouping only reorders and interleaves headings. The heading marker is a
sentinel object (`__providerHeading`) consumed at the top of the same loop, so there is one
card-rendering path, not two. A test asserts the in-use marker survives grouping.

## 6. Multi-machine posture

Machine-local BY DESIGN — this is dashboard rendering of data the server already merged.
Nothing replicates. The pool view's own machine tagging is untouched.

## 7. Failure modes

`groupAccountsByProvider` handles a non-array (returns []), a missing provider (grouped under
`Other`), and a non-string provider (coerced to the empty key). It has no I/O and cannot throw
for any accounts array the existing renderer would have accepted.

**Security**: the heading is the only new dynamic string reaching the DOM. It goes through
`friendlyProvider`, which maps known providers and sanitizes everything else, and is written
via the module's `el()` textContent helper. A test plants `<img src=x onerror=...>` as a
provider and asserts no live element and no `onerror` attribute survives.

## 8. Rollback cost

Change one call site back to `for (const a of accounts)`. No state, no migration, no config.

## Evidence

8 new tests in the existing jsdom suite, which drives the SHIPPED `dashboard/subscriptions.js`
against a real DOM. Shown capable of failing: reverting the call site fails exactly the 4
grouping assertions while the 4 invariant tests keep passing — the correct signature, since
those describe behaviour that must hold either way.

Controls carry the weight here: a single-provider list is asserted UNCHANGED (no heading), and
account order within a group is asserted preserved. Without those, "grouping works" would pass
equally well against a change that sorted everything alphabetically and added a redundant
heading to every single-provider install.

One test was WRONG on first run and the code was right: it asserted `innerHTML` lacks the
substring "onerror", but correctly-escaped text still reads `&lt;img src=x onerror=...&gt;`.
The assertion now tests the real property — no live element, no such attribute, heading has no
element children — rather than the absence of characters.
