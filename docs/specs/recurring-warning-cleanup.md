---
title: Secret-externalization-aware Telegram-token readiness check
status: approved
author: echo
date: 2026-05-29
review-convergence: "2026-05-30T03:32:52.185Z"
review-iterations: 1
review-completed-at: "2026-05-30T03:32:52.185Z"
review-report: "docs/specs/reports/recurring-warning-cleanup-convergence.md"
approved: true
approved-note: "Fast-tracked by echo in autonomous mode at Justin's request (topic 15160, 'enter autonomous mode and tackle and fix all of these issues'). Tiny, self-contained, log-only false-positive fix; not multi-machine. Disclosed in the convergence report and to Justin."
---

# CoherenceMonitor: secret-aware Telegram-token readiness (non-multi-machine)

A small, self-contained, log-only fix done in autonomous mode at Justin's
request. NOT multi-machine.

## Problem

`CoherenceMonitor`'s `readiness-telegram-token` check used a
`typeof token === 'string'` guard. After secret-externalization the token in
`config.json` is the `{ secret: true }` placeholder (the real value lives in the
encrypted store), so the string-type guard read it as missing and emitted
"Telegram configured but token missing" every coherence cycle (20×/run in
Echo's log) — a false alarm, since the token is present (just stored securely).

## Fix

A token is "configured" if it's a non-empty string OR the `{ secret: true }`
placeholder. The module-private `isSecretPlaceholder` in `SecretMigrator` is now
exported and reused (single source of truth for the placeholder shape), and
`CoherenceMonitor` uses it. A genuinely-missing/empty token still fails the check.

## Why safe / blast radius

- Additive, widening: only adds the placeholder as a "present" case; a missing
  token still fails. No new authority, read-only.
- No agent-installed files, no config defaults, no hooks, no skills → no
  `PostUpdateMigrator` entry. Pure `src/`.
- Not multi-machine — touches `SecretMigrator` (export only) + `CoherenceMonitor`.

## Testing

- Unit: `secret-migrator.test.ts` (+`isSecretPlaceholder`: true only for
  `{secret:true}`, false for strings/empty/null/lookalikes) — 17 pass.
  `tsc --noEmit` clean.

## Coordination note

This started as a 2-fix "recurring-warning cleanup" batch. The second fix
(revert-detector spamming SourceTreeGuardError on a self-hosting checkout) was
found ALREADY FIXED on main by #552 — which added `sourceTreeReadOk: true` so
the detector legitimately runs against the instar source tree (a better fix than
my proposed self-disable, since it keeps the feature working). Dropped my
redundant version on discovery — a direct example of why concurrent work must be
checked against `main` before shipping.

## Out of scope (root-cause investigation needed, tracked separately)

- Feedback-webhook 429 spam (something generates ~42 feedback items/run —
  suppressing the log would mask the generator).
- CapabilityMapper "Manifest HMAC verification failed — will rescan" each boot
  (downgrading the log could mask a real manifest-integrity issue).
