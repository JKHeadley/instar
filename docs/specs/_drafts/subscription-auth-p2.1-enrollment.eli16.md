# P2.1 — Mobile-First Enrollment Wizard — Plain-English Overview

> The one-line version: enrolling a new subscription account from your phone, with a code that re-issues itself if it expires before you get to it.

## The problem in one breath

To add another Claude (or Codex) subscription to the pool, you have to log into it. Logging in means: a short code or a link shows up, you open it on the provider's own page, and you approve. But that code expires in about 15 minutes — and if you're away from the keyboard (the whole point of doing this from your phone), it's dead by the time you tap it, and re-issuing a fresh one is a manual round-trip back at the terminal. We hit this exact wall during the pi-harness test.

## What this adds

A small wizard that makes enrollment phone-friendly and expiry-proof:

1. **You start an enrollment** (from the dashboard) — instar drives the framework's login and shows you a short code + a link.
2. **You approve on your phone** — you open the provider's own page and confirm. Nothing secret ever passes through instar; only the public code/link does.
3. **If the code expires before you act, instar quietly issues a fresh one** — no terminal trip, no asking. The pending login is remembered durably, so it even survives a server restart.

## The new pieces

- **PendingLoginStore** — a durable list of logins-in-progress. It holds only public things: the link, the short code, when it expires, how many times it's been re-issued. There is *no place to put a token* — that's a safety guarantee by construction, the same way the account registry refuses to store secrets.
- **EnrollmentWizard** — the brain: it starts a login, and on a timer it sweeps for any expired codes and re-issues them automatically. If a re-issue fails (e.g. the login tool hiccups), it logs it and tries again next sweep instead of giving up on everything.
- **FrameworkLoginDriver** — the hands: it actually runs the framework's login command (Codex uses a device-code flow; Claude uses a link + paste-back-code flow) and reads the public code/link off the screen.

## The safeguards

- **Nothing secret ever stored or shown** — only the public code/link the provider itself shows you. No tokens, no API keys.
- **Ships OFF / operator-only** — the enrollment routes do nothing until you start an enrollment, and they aren't surfaced as a public capability until the whole standard graduates.
- **One bad re-issue can't break the rest** — the auto-reissue sweep skips a failed login and keeps going.
- **Proven by tests** — 13 unit tests already cover the durable store and the auto-reissue gap; integration + end-to-end tests confirm the routes are alive and a started enrollment survives a restart.
