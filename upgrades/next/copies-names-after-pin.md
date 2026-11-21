# The Bitwarden confirm page shows secret names only after the PIN

<!-- bump: patch -->

## What Changed

SEC-129. `GET /recommended-services/:id/confirm` is reachable before any sign-in. For a service that copies the agent's secrets (Bitwarden), it used to list the name of every stored secret. It now returns only `copiesCount`. The names come from `POST /recommended-services/:id/confirm` with `answer: 'names'`, which needs the page's live token and the PIN (the same `checkConfirmPin` as a yes or no, with its guessing limits), never spends the token, and changes nothing. The confirm page (`dashboard-pair/service-yes.js`) shows the count and a "Show their names" button that uses the PIN typed above.

## What to Tell Your User

- **Secret names stay private**: "My Bitwarden yes-or-no page now says how many secrets it would copy. To see their names first, type your PIN and tap Show their names."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Secret names on the Bitwarden confirm page after the PIN | Type the PIN on the page, tap "Show their names" |

## Evidence

- `tests/unit/recommended-services-copies-pin.test.ts` (new, all 3 fail on main): the public answer has the count and no names; the names come with the live token and the PIN, and the token still works afterwards; a wrong PIN, a dead token and no token are refused.
- `tests/unit/service-yes-copies-page.test.ts` (new, all 3 fail on main): the real page script in jsdom shows the count first, asks with `answer: 'names'` and the PIN, then lists the names; a wrong PIN shows no names.
- `tests/integration/recommended-services-bitwarden.test.ts` and `tests/e2e/recommended-services-alive.test.ts` updated to the count plus names-after-PIN.
