# Side-Effects Review — The accounts screen says "needs you" only when it does

**Version / slug:** `signin-honest-states`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `not required at this risk; one independent reviewer subagent ran anyway, findings below`

## Summary of the change

Tier 1: 3 dashboard files, 2 server files, 3 test files, about 150 lines of code and tests plus these notes. One review round, about 3 test runs. Sign-in cells on the console and phone accounts surfaces are classified using the repair blocker list and the identity-drift record. Fixes fb-b22a6402-0de and the surface half of fb-43229fd7-732.

## Decision-point inventory

One display decision: does a cell count toward "needs you". It feeds Home's count through `needs-model.js`. It gates nothing: no repair, swap, session or message depends on it.

## 1. Over-block

A real problem could be left out of the count: an account truly signed out that has no confirmed incident now reads "still checking" and doesn't count. It stays visible with a Sign in button and a line on the Accounts page. Accepted, because the alternative is the false alarm the operator reported.

## 2. Under-block

A wrong login under a day old doesn't count. No automatic repair exists for a stuck wrong login; this change surfaces it and offers the exact-account Sign in. A drift with no detection date counts as stuck, so an unknown age can't hide it.

## 3. Level-of-abstraction fit

Classification lives in the two existing view models. They are separate code in two languages, so the rule is written twice; tests pin both. No new detector.

## 4. Signal vs authority compliance

Compliant. Reference: `docs/signal-vs-authority.md`. This is a display of existing signals with no blocking authority.

## 5. Interactions

`requiresOwnerRelogin` cases count as needs-you in both views. The console's old failed episode no longer outranks a current blocker, which is the Nov 5 case. `/subscription-relogin?scope=pool` gains one more caller, bounded by a 6 second timeout and the phone read cache.

## 6. External surfaces

Operator-visible wording and counts change on the dashboard and phone. Phone state values are unchanged: waiting cells use the existing `unknown`, so app builds already installed still decode them. The other account's address stays off the phone. The dashboard shows it, to the operator only.

## 6b. Operator-surface quality

(1) Primary action: a counted cell leads with its Sign in button, and a waiting cell keeps one. (2) Raw internals: none as primary content; the blocker reason codes are turned into words. (3) Destructive actions: none added. (4) Plain language at phone width: the labels are short sentences. The longest is the settling wrong-login label; I have not yet seen it on a live phone screen, and that check follows the release.

## 7. Multi-machine posture

Proxied on read: both surfaces use the merged `scope=pool` reads, and blockers match on account and machine. A machine whose blockers can't be read keeps its previous state. An older peer with no blockers field behaves the same way.

## 8. Rollback cost

A revert and a release. No state, config or migration is involved.

## Second-pass review

The reviewer did not concur at first and raised five points; it did not re-review after the fixes. Acted on: a fresh wrong login can correct itself, so it now waits a day; the other account's address is off the phone; a login gone from the machine now counts on either surface; the loopback timeout went from 8 to 6 seconds. Checked and left: `X-Instar-Request` is not needed on this GET; `start-cell` resolves the slot from the account id and has no status gate in the part I read, but the Sign in path on a wrong-login cell has not been run live.
