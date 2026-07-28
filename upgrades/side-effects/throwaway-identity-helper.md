# Side-Effects Review — throwaway-identity helper

**Version / slug:** `throwaway-identity-helper`
**Date:** `2026-06-10`
**Author:** `echo`
**Tier:** `1` (standalone test-tooling script + lib + hermetic test; no runtime/gate/config wiring)
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `scripts/lib/throwaway-identity.mjs` (importable) + `scripts/throwaway-identity.mjs`
(CLI) — mints genuinely-distinct, readable throwaway email inboxes via the mail.tm public
disposable-mailbox API, and polls/extracts codes+links from them. The autonomous half of
test-identity provisioning for live-integration test harnesses (Slack/Discord/…). + a fully
hermetic unit test (injected fetch + clock, no network) and an ELI16.

## Decision-point inventory

None in runtime — it's standalone tooling, never imported by `src/` or wired into a gate.
Internal branch points (domain selection, message-match filter, timeout) are pure functions
covered by the test.

## 1. Over-block

Nothing is rejected at runtime. The tool only calls a public disposable-mail API and reads
inboxes it just created. It is not on any agent code path.

## 2. Under-block

It deliberately does NOT cover the anti-bot signup CAPTCHA at workspace/account creation —
that is a human-verification control and remains a ~30s human handoff (documented in the
live-run runbook). It is the email half only.

## 3. Level-of-abstraction fit

Right layer: a `scripts/` + `scripts/lib/` test utility beside the other dev/test scripts,
with the HTTP injected so the test is hermetic. Reusable by any integration's live harness,
not coupled to the permission gate.

## Migration / rollback

No migration (standalone tooling). Rollback = delete the two scripts + the test.

## Testing-integrity note

15 hermetic unit tests (pure extractors + the full mint / poll-until-match / timeout flow,
HTTP + clock injected). A separate live CLI smoke confirmed it mints a real inbox
(`echo-…@web-library.net` + token). `tsc --noEmit` clean.
