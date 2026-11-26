# Side-Effects Review — the console becomes the dashboard's front door; a pairing code page

**Version / slug:** `dashboard-console-default-and-pair-page`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagents (spec rounds 1 and 2) + cross-model codex gpt-6-astra`

## Summary of the change

Operator decisions 2026-11-03 11:54 PST. (1) `GET /dashboard` 302s to `/dashboard/console/` when there is no query string, and to `/dashboard/legacy?<same query>` when there is one; `/dashboard/legacy` serves the legacy `index.html`. (2) A standalone pairing code page at `/dashboard/pair` (files in `dashboard-pair/`, outside the static mount; strict CSP and all four dashboard headers set in its own handlers). It does PIN unlock, then the waiting phones' codes with Copy and decline, then the paired phones with Remove, through the existing operator-session routes. (3) `codePageUrl` on the mint answer and the dashboard-path redeem answer. (4) Console links to legacy use `/dashboard/legacy`; the Phones tile opens `/dashboard/pair`; the pinned Telegram dashboard quick links and the truncated-message hint point at console pages; the installer's closing line names the code page. (5) CLAUDE.md template + `migrateClaudeMd` rewrites (console bullet; three pairing-without-Telegram lines).

Tier 2. About 25 files, about 1,300 added lines, about half of them tests. Spec review: 5 rounds of a 6-round cap (⚠ a lot for a redirect and a small page; rounds 3 to 5 each found a narrower request-lifecycle gap in the page's code, each fixed with a test). Commit attempts are recorded in the PR.

## Decision-point inventory

- `/dashboard` redirect target: deterministic on whether a query string is present. No new gate.
- Pair page headers: fixed, set per handler.
- `codePageUrl` host: the redeem host that redeem already validated; the mint origin. No new acceptance rule.
- Who may see a code: unchanged (`/mobile/pairing-approvals`, Bearer + operator session).

## 1. Over-block

Nothing new is refused. A spelling of the page's address that Express does not route to its handlers (`/dashboard/pair.html`, percent-encoded) reaches the auth middleware and is refused, as it was before the page existed. A bookmark of `/dashboard/` that expected the legacy page now gets the console, with the legacy page one link away.

## 2. Under-block

The code page opens no new way to reach a code: it uses the same operator-session route as the legacy Phones tab, and it asks for a fresh PIN even when the console's token is stored. A look-alike page at another address can still collect a PIN, as with any dashboard today. Mitigations: the host is the page title, the agent sends the link only to the verified operator and never with the PIN, and the app only opens a code page on the origin it paired with.

## 3. Level-of-abstraction fit

The routes live in one module (`dashboardEntry.ts`) that AgentServer and the tests both mount, and the addresses in one dependency-free module (`dashboardPaths.ts`), so the CLI, the Telegram adapter and the pairing routes share them. The code page is standalone rather than a console route, because the console needs `cdn.jsdelivr.net` (its Files page) and so cannot carry a strict policy as a whole.

## 4. Signal vs authority compliance

No new authority. The page is a viewer over existing authority-bearing routes.

## 4b. Judgment-point check

None. All the new decisions are deterministic routing.

## 5. Interactions

- Legacy deep links (`?tab=`, `?ratify-deferral=`, file links from `/api/files/link`, mandates, subscriptions, feedback-drain) carry a query, so they keep opening legacy.
- The preview mount (`/dashboard/preview/`) is registered after the pair page and is untouched.
- The legacy page's own navigation uses `location.pathname`, so it stays on `/dashboard/legacy`.
- The console's stored token (`instar_token`) is not read or written by the code page.
- The migrator: the console rewrite runs before the insert-if-missing check, so there is no duplicate bullet. The pairing rewrite is keyed on line prefix plus `Phones`, its fresh lines never contain `Phones` (tested), and it composes with the word-code rewrite and the code-line rewrite in either order (tested across four shipped wordings).

## 6. External surfaces

- New routes: `/dashboard/legacy`, `/dashboard/pair`, `/dashboard/pair.js`, `/dashboard/pair-model.js`, `/dashboard/pair.css` (all public static content; no data without auth).
- Changed: `GET /dashboard` 200 → 302.
- New response field: `codePageUrl`.
- New package folder: `dashboard-pair/` (`package.json` `files`; `tests/unit/package-completeness.test.ts` now requires it).
- `dashboardSecurityHeaders` matches `/dashboard` case-insensitively (any `/Dashboard/…` spelling Express serves now gets the same headers).
- The pinned Telegram dashboard message text changes (links).

## 6b. Operator-surface quality

The console changes are link targets only (three `/dashboard` links now name `/dashboard/legacy`; the Phones tile opens `/dashboard/pair`); nothing on the console's screens moves. The new surface is the code page:

1. **Leads with the primary action: yes.** The page opens on the PIN box and "Show the code". After unlock, the first card is the waiting phone's code in 2.6rem monospace with a blue Copy button right under it. The paired-phones list comes below the codes, and the codes render before that list's request returns.
2. **Zero raw internals as primary content: yes.** The headline is the agent's host name and then the code. The phone is named by its device name, the person it belongs to, and the minutes left on the code. The key fingerprint is a small muted support line under the code, there so the operator can compare it with the phone; no ids, JSON or enum values are shown.
3. **Destructive actions de-emphasized: yes.** "Not my phone — decline" and "Remove this phone" are plain text links, quieter than the filled Copy button and placed below it.
4. **Plain language and phone width: yes.** Labels are "Show the code", "Copy", "Copied", "Press and hold the code to copy it", "The agent did not answer. Try again." The column is at most 560px with a 16px gutter. Long hosts and codes wrap (`word-break`), so nothing scrolls sideways. Buttons have 12px padding for real tap targets.

## 7. Multi-machine posture

Per machine and stateless. A code stays in the memory of the machine that issued it; `codePageUrl` uses the host the phone redeemed on, which reaches that machine.

## 8. Rollback cost

Revert the PR. A 302 is never cached permanently, so the legacy default returns at once. Agents already migrated keep CLAUDE.md lines naming `/dashboard/legacy` and `/dashboard/pair`, so the revert PR ships the reverse line rewrite.

## Conclusion

Smallest change that delivers both operator decisions without weakening pairing. Ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagents (spec rounds 1 and 2), 2026-11-03, and codex gpt-6-astra (rounds 1 and 2).
Concur after changes. Five rounds (`docs/specs/reports/dashboard-console-default-and-pair-page-convergence.md`):
- Round 1: the installer text, the pinned Telegram links, the case-variant headers, the variant-test wording, the migration ordering, the session-expiry wipe.
- Round 2: phone clock skew, the Copy deadline, the legacy trailing slash, the header middleware's case match (it also closed an existing framing gap on `/Dashboard/…`), the polling restart, and a package-completeness guard.
- Rounds 3 to 5 (codex with the page source): one 403 rule and one time limit plus cancellation for every call, body included; the code renders before the paired-phones list; stale answers are dropped across a reset and a re-unlock; a declined phone stays gone; and the PIN screen's own calls are bounded.

Round 5's two small items were fixed with tests but not re-reviewed (cap rule).

## Evidence pointers

- `tests/unit/dashboard-pair-page.test.ts`
- `tests/integration/dashboard-console-default-and-pair-page.test.ts`
- `tests/integration/mobile-dashboard-pairing.test.ts` (`codePageUrl`)
- `tests/e2e/dashboard-console-default-lifecycle.test.ts`
- `tests/unit/console-claude-md-awareness.test.ts`, `tests/unit/pairing-without-telegram-claude-md-awareness.test.ts`

## Class-Closure Declaration (display-only mirror)

Not applicable: a feature change, not a defect fix.
