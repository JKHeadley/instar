# Automatic Claude Code and Codex re-login — plain-English overview

## What this changes

When a corroborated Claude Code or Codex login failure occurs, Instar can now repair the exact account on the exact machine with no repeated dashboard click. It starts the provider's native login, opens that identity's dedicated pre-signed-in browser profile, completes the provider page, handles Claude's paste-back or Codex's device-code flow as appropriate, and independently proves the right account works again.

The Subscriptions dashboard can also create the dedicated Chrome profile itself. You enter the Google account and a friendly profile name from your phone; Instar prepares the private profile on the target machine. If the provider truly needs a password, authenticator, CAPTCHA, or consent action, the agent sends one secure link or shows one dashboard prompt. You never need physical or remote-desktop access to that machine.

## Why this is not simply “store the password and try things”

Instar never stores passwords, TOTP seeds, OAuth tokens, browser cookies, or returned codes in the repair database. Durable state contains only opaque account/profile IDs, closed status values, timestamps, retry counts, and redacted audit events. Password/TOTP values are fetched from named vault entries only inside the browser worker and submitted only to exact provider-owned origins. They never enter an LLM prompt, API response, screenshot, log, Telegram message, or repair record.

No account is silently enrolled. Unattended repair requires both `mode: unattended` and the exact canonical subscription email in an operator-controlled allowlist. The defaults additionally require ten successful same-path repairs over thirty days. A verified operator may lower those two rollout floors for named identities, but wrong-identity or unexpected-origin history always blocks unattended execution.

## What “automatic” means

For an explicitly allowlisted identity, the controller owns the normal work and bounded recovery without asking for a dashboard approval on every expiration. It can reacquire a busy browser seat, refresh an expired public login artifact, recover after a process restart, and retry typed transient provider failures. State is durable, so a restart does not forget what happened or blindly repeat an uncertain click. Approval mode remains available as a rollout fallback.

Success is intentionally difficult to claim. Instar must independently prove the expected provider identity, fresh authenticated use, the correct isolated credential slot, pool recovery to active, and closure of the exact original sign-in incident. A credential file merely existing is not success.

## When it stops and asks for a person

It refuses rather than improvises on CAPTCHA, phone confirmation, provider risk review, account chooser ambiguity, wrong identity, unexpected origins, added permissions, billing, recovery-email or MFA-setting changes. It also stops when vault/profile mappings are missing or ambiguous. These are fixed boundaries, not decisions delegated to an LLM.

Retries are bounded: three attempts, two artifact reissues, ten minutes, one browser drive per host, and one repair per account/machine cell. Security events stop immediately; repeated ordinary failures open a durable 24-hour breaker. Cancellation aborts the browser worker, releases the seat, clears in-memory secrets/codes, and prevents new pane writes.

## Rollout posture

The fleet still ships dark, dry-run-first, approval-mode by default. Justin explicitly authorized unattended repair for Echo's registered Claude Code and Codex subscription identities on 2026-09-15. That local promotion does not silently change other agents. Broadening provider origins/scopes, adding another provider, or bypassing a provider security challenge still requires a separate decision.

## What was decided

The repeated approval click is removed for the explicitly configured identities. CAPTCHA, phone/risk confirmation, wrong identity, unknown origin, and permission expansion remain genuine human/security boundaries; the automation never clicks through them.
