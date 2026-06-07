---
kind: spec
id: subscription-auth-p2.1-enrollment
title: P2.1 — Mobile-First Enrollment Wizard (durable pending-login store + auto-reissue)
status: approved
parent: subscription-auth-standard
date: 2026-06-07
author: echo
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The enrollment flow's fragile step — a login code that expires before the operator (on their phone, away from the terminal) gets to it — is closed in code, not by the operator remembering to re-issue. The PendingLoginStore makes in-flight logins durable (they survive a server restart) and the EnrollmentWizard auto-reissues a fresh code the moment one expires. The store stores PUBLIC artifacts only (device-code / verification URL / TTL) — never a token — enforced by construction (there is no field to hold a secret), the same structural credential-safety guard P1.1 uses for the account registry."
review-convergence: internal-grounded-2026-06-07
review-convergence-detail: "Internal convergence (single-agent, noted honestly — no cross-model reviewer this round). Grounded against the real pi live-test specimen that motivated it: during the pi-harness onboarding the first login code expired before Justin acted on it and re-issuing took a manual round-trip — the exact gap P2.1 closes. The orchestration core (PendingLoginStore + EnrollmentWizard) is already implemented and green (13 unit tests: issue/expiry/active surfaces, auto-reissue-on-expiry incl. reissueCount, driver-failure resilience leaving the login expired for the next sweep, per-provider default flow kind, complete). The interactive leg (driving the framework login CLI to obtain the public code/URL) is INJECTED (LoginDriver), so the orchestrator is pure + hermetic; the concrete driver scrapes a tmux pane and is unit-tested with a fake capture. Load-bearing premise verified: device-code / URL+code-paste are the two real flows (Codex = device-code; Claude = URL+paste-back-code), and both yield a PUBLIC artifact the operator types into the provider's own page — nothing secret transits instar."
approved: true
approved-by: Justin
approved-via: "Telegram topic 20905 (2026-06-07): 'Approved for all. Please enter a 12 hour autonomous session to finish this out.' — blanket approval of the remaining Subscription & Auth phases (P2.1 enrollment wizard named explicitly in the autonomous task breakdown). Recorded per the autonomous-directive precedent."
eli16-overview: subscription-auth-p2.1-enrollment.eli16.md
---

# P2.1 — Mobile-First Enrollment Wizard

> Tier-2 by association (it spawns a framework login process and writes a durable
> store), but it ships DARK + operator/internal: the routes nest under
> `/subscription-pool` (already INTERNAL) and do nothing until an operator starts
> an enrollment. No live-session path is changed.

## Goal

Make enrolling a new subscription account **phone-friendly and expiry-proof**. The
operator should be able to start a login from the dashboard, get a short code +
URL on their phone, approve at the provider's own page, and have instar finish the
enrollment — and if the code expires before they get to it, instar silently
re-issues a fresh one instead of stranding the flow.

## The gap this closes (grounded)

During the pi-harness onboarding live-test, the framework login emitted a
device-code that **expired before the operator acted on it**, and re-issuing took
a manual terminal round-trip. A login that depends on the operator being at the
keyboard within a 15-minute TTL is exactly the willpower-dependent fragility
"Structure beats Willpower" forbids. P2.1 makes the in-flight login durable and
auto-reissues on expiry.

## What P2.1 adds

1. **`PendingLoginStore`** (new, src/core/) — a durable ledger of in-flight logins.
   Each record holds PUBLIC artifacts only: `verificationUrl`, optional `userCode`,
   `kind` (device-code | url-code-paste), `provider`, `framework`, `expiresAt`,
   `reissueCount`, `status` (pending | expired | completed | cancelled). **There is
   no field to hold a token** — credential-safety by construction. TTL/expiry +
   `active()` / `expired()` surfaces. Survives a server restart.
2. **`EnrollmentWizard`** (new, src/core/) — orchestration on top of the store:
   - `start(input)`: drive the framework login (injected `LoginDriver`), capture
     the public code/URL, store it as a pending login with its TTL visible.
   - `reissueExpired()`: for every expired pending login, re-drive the flow and
     refresh the code/URL/TTL **without the operator asking**. Driver failures are
     skipped (logged, left expired for the next sweep) so one bad re-drive can't
     abort the sweep.
   - `defaultKind(provider)`: Codex/OpenAI = device-code (its endorsed flow);
     everyone else = url-code-paste (the phone-friendly Claude path).
   - `complete(id)` / `pending()`.
3. **`FrameworkLoginDriver`** (new, src/core/) — the concrete `LoginDriver`: spawns
   the framework's login command under the target account's `CLAUDE_CONFIG_DIR` in
   a tmux pane, scrapes the verification URL + code + TTL from the pane, and returns
   the public artifact. Pure-scrape logic is unit-tested with a fake pane capture.
4. **Routes (under `/subscription-pool`, INTERNAL/dark):**
   - `POST /subscription-pool/enroll` — start an enrollment → returns the pending login.
   - `GET /subscription-pool/pending-logins` — the phone surface (active logins).
   - `POST /subscription-pool/enroll/:id/complete` — mark done once the operator
     approved + the account enrolled (adds the account to `SubscriptionPool`).
   - `POST /subscription-pool/enroll/reissue-expired` — manual sweep lever (the
     background tick calls the same `reissueExpired()`).
5. **Background reissue tick** — server wires a low-frequency interval that calls
   `EnrollmentWizard.reissueExpired()` so expired codes refresh on their own.

## Tests (3 tiers)

- **Unit (done, 13):** store issue/expiry/active; wizard start→store, auto-reissue
  on expiry (reissueCount, fresh code), driver-failure resilience, default kind,
  complete. Plus `FrameworkLoginDriver` scrape logic against fake captures.
- **Integration:** HTTP — POST enroll returns a pending login with a public code;
  GET pending-logins lists it; complete moves it off the surface and into the pool;
  reissue-expired refreshes an expired one. Assert NO token field ever appears.
- **E2E (feature alive):** production init path mirroring server.ts — the enroll
  routes return 200 (not 503), the store + wizard are wired non-null, and a started
  enrollment survives a simulated restart (durability).

## Rollout

Dark + operator/internal. Routes stay under `/subscription-pool` (INTERNAL until
graduation). Migration parity: new store file is created lazily; no config change
required (a `subscriptionPool.enrollment` block tunes TTL/sweep cadence, optional).
Single-account / no-enrollment agents are a no-op.

## Open for operator (tier-2 awareness)

- Auto-reissue cadence (default: sweep every 5 min; re-issue immediately on the
  first sweep that sees an expired login).
- Completion detection is operator-triggered by design: the operator confirms via
  the `/complete` route / dashboard button once they approve at the provider. v1
  deliberately does NOT auto-detect completion (which would mean polling the
  configHome for fresh credentials) — explicit operator confirmation is the
  intended, simpler contract for the dark/operator-gated rollout.
