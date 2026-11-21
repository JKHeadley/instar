# Side effects: the Bitwarden confirm page shows secret names only after the PIN (SEC-129)

In plain words: the pre-sign-in confirm page answer for a secret-copying service (Bitwarden) now carries how many secrets would be copied, not their names. The names come from the same confirm request with the PIN.

Tier 1. Size: 2 source files (one route handler, one page script), 2 new unit test files, 2 updated test files.

## What changes for running agents
- `GET /recommended-services/:id/confirm`: `copies` (names) is replaced by `copiesCount` (a number). Only recipes with `listsCopies` (today: Bitwarden) carry it.
- `POST /recommended-services/:id/confirm` accepts `answer: 'names'`, which needs the same `X-Instar-Request` header, a live page token and `checkConfirmPin` (with its guessing budget) as a yes or no. It answers `{ copies: [...] }` with `Cache-Control: no-store`, never consumes the token, records nothing and starts nothing. For a service without `listsCopies` it answers 404 `no-copies`.
- The confirm page shows "A copy of N stored secrets" and a "Show their names" button. A wrong PIN, too many tries or an insecure connection each get their own plain message.
- Readers: the only reader of `copies` was this page. `dashboard/console/services-model.js` links to the page and reads the list route, which does not change. No native app reads this route.

## Why an extra step, and why no lossless fix
The page link (`/dashboard/service-yes?service=bitwarden`) carries no secret, and opening it mints the page token for whoever opens it. So until the PIN is typed, the server cannot tell the owner from a stranger who knows the agent address. A fix that keeps the names on first load would need a per-owner signed link, which changes how every recommended-service offer is sent: a larger change than this low finding. The added step is optional and costs one tap: the count is always shown, the yes and no answers work exactly as before, and the names appear in place with the PIN already typed for the answer. Leaking the names is a reconnaissance gift (which providers, bot tokens and keys the agent holds) to anyone with the tunnel address, which is why the names move behind the PIN rather than stay public.

Decision basis: the Chief of Staff decided this shape on 2026-11-21 (01:50Z): stop listing the names in the pre-auth answer and keep the confirm flow working. The constitution check rates this a possible violation of "Security Fixes Keep the Experience Whole", because the finding is low and a lossless variant exists. That variant: the page sends the dashboard sign-in it already holds (same origin), and a signed-in owner gets the names on first load. It needs a sign-in check added to these pre-auth routes, so it is its own PR, tracked as commitment CMT-024 on the M5 (m_a804869356), PR by 2026-11-26 17:00 PST. Until then the cost is one optional tap with the PIN already typed.

## Live proof
This machine (the M5) does not run live servers or integration/e2e tests by hand (standing rule for this session). The real-server path is covered by `tests/e2e/recommended-services-alive.test.ts` (updated: the bitwarden page answer is a count with no names), which Local Verify runs on the verify machine before merge. The page itself is exercised by loading the real script in jsdom against the exact answers the route gives. The PR asks Local Verify for the full run; the merge gate does not pass without it.

## 6b. Operator-surface quality
1. Primary action first: the page still leads with the service, what you get, and the PIN with "Yes, set up …". The new button is a quiet link-style button inside the "What gets copied" section, below the answer controls.
2. No raw internals as primary content: the page shows a count in a sentence, and the names only on request; no ids, tokens or field names.
3. Destructive actions: none added. Asking for the names records no answer and changes nothing.
4. Plain language at phone width: one sentence plus one short button label; the button reuses the page's existing link-button style, so it wraps like the existing "No" button.

## Signal vs authority
Read-side disclosure only. The names now sit behind the same token and PIN check as the answers; nothing new is granted.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/recommended-services-copies-pin.test.ts` (new, real routes and ledger, the PIN stub accepts only the PIN the tests send): count only in the public answer; the names with the token and PIN, the token still live afterwards; refusals for a wrong PIN, a dead token and no token (these 3 fail on main); asking for the names records nothing in the ledger and starts nothing. Not covered by a test: the 404 `no-copies` answer for a service without `listsCopies` (the test catalog holds only Bitwarden).
- `tests/unit/service-yes-copies-page.test.ts` (new, the real page script in jsdom with a stubbed fetch): count first and no names; the button posts `answer: 'names'` with the token and PIN and then lists the names; a wrong PIN shows no names and clears the PIN box. All 3 fail on main.
- Updated, not run on the M5 per the machine rule: `tests/integration/recommended-services-bitwarden.test.ts` and `tests/e2e/recommended-services-alive.test.ts`.
- Also pass: `recommended-services-catalog`, `recommended-services-offers`.
- Trial merge against the 6 open recommended-services PRs (#3531, #3534, #3535, #3536, #3540, #3558) and the open console PR #3579: clean.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. Verdict: concur, no blocking findings. It confirmed that the `names` branch sits behind every existing guard. The PIN check refuses insecure connections first, and a wrong PIN spends the same per-token budget as a yes or no, so it is not a cheaper oracle. Token minting is rate-limited, and nothing else exposes the names before sign-in. The page renders names only via textContent, and the yes/no flow is unchanged. Non-blocking notes and what was done: the "above" wording (fixed: the PIN box is below); the PIN box not clearing after a wrong PIN (fixed); a test that asking for names records nothing (added). It also raised an older weakness of its own: the PIN budget is per page token and minting allows about 30 a minute, so roughly 150 guesses a minute agent-wide. That predates this change and was reported to the Chief of Staff as a new finding. Asking for the names on a guessed PIN confirms the guess without recording an answer; that is part of the same finding.
