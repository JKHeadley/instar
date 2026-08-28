# Assisted Claude Code re-login — plain-English overview

## What this changes

Today Instar can tell when a subscription account genuinely needs to sign in again, but it deliberately stops there. This update adds the repair half. When a corroborated Claude Code login failure occurs, the dashboard shows one **Repair sign-in** button. One click authorizes one account on one machine. After that, Instar performs the routine flow itself: starts Claude's native login, opens the right isolated browser profile, completes the provider page, returns the one-time code to the waiting CLI when needed, and independently proves the right account works again.

The Subscriptions dashboard can also create the dedicated Chrome profile itself. You enter the Google account and a friendly profile name from your phone; Instar prepares the private profile on the target machine. If the provider truly needs a password, authenticator, CAPTCHA, or consent action, the agent sends one secure link or shows one dashboard prompt. You never need physical or remote-desktop access to that machine.

## Why this is not simply “store the password and try things”

Instar never stores passwords, TOTP seeds, OAuth tokens, browser cookies, or returned codes in the repair database. Durable state contains only opaque account/profile IDs, closed status values, timestamps, retry counts, and redacted audit events. Password/TOTP values are fetched from named vault entries only inside the browser worker and submitted only to exact provider-owned origins. They never enter an LLM prompt, API response, screenshot, log, Telegram message, or repair record.

The ordinary agent API token cannot approve a repair. The click uses a short-lived operator proof minted only after the dashboard PIN is unlocked. It is scoped to one immutable episode and cannot be replayed for another account or machine.

## What “autonomous after one click” means

After approval, the controller owns the normal work and bounded recovery. It can reacquire a busy browser seat, refresh an expired public login artifact, recover after a process restart, and retry typed transient provider failures. State is durable, so a restart does not forget what happened or blindly repeat an uncertain click.

Success is intentionally difficult to claim. Instar must independently prove the expected provider identity, fresh authenticated use, the correct isolated credential slot, pool recovery to active, and closure of the exact original sign-in incident. A credential file merely existing is not success.

## When it stops and asks for a person

It refuses rather than improvises on CAPTCHA, phone confirmation, provider risk review, account chooser ambiguity, wrong identity, unexpected origins, added permissions, billing, recovery-email or MFA-setting changes. It also stops when vault/profile mappings are missing or ambiguous. These are fixed boundaries, not decisions delegated to an LLM.

Retries are bounded: three attempts, two artifact reissues, ten minutes, one browser drive per host, and one repair per account/machine cell. Security events stop immediately; repeated ordinary failures open a durable 24-hour breaker. Cancellation aborts the browser worker, releases the seat, clears in-memory secrets/codes, and prevents new pane writes.

## Rollout posture

The fleet ships dark and dry-run-first. The first live mode is approval-gated; unattended repair remains disabled. A controlled disposable identity must pass the supported-path acceptance matrix before Echo is promoted locally. Using a real operator-owned subscription for a canary, broadening provider origins/scopes, or enabling unattended mode requires a separate explicit decision.

## What you need to decide

Approve this first-release boundary: one click per corroborated incident, then autonomous bounded repair, with the hard stop cases above. No decision is needed about unattended mode in this release; it stays dark.
