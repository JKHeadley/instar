---
bump: patch
---

## What Changed

The lifeline replay queue no longer counts a failed forward toward the 3-strike drop budget when the server is known-down (supervisor unhealthy). Strikes now only accrue when a healthy server refuses the message — the message-specific poison case the drop policy was designed for. Mirrors the existing version-skew exemption.

## What to Tell Your User

Messages you send while your agent's server is restarting can no longer be silently dropped by the retry limit. They wait in the queue until the server is back and then deliver. (Previously a multi-minute restart window could exhaust the 3 retries in about 90 seconds and drop the message with only a resend-notice.)

## Summary of New Capabilities

- Inbound Telegram messages queued during a server restart survive arbitrarily long down-windows; the replay drop budget only burns against a healthy-but-refusing server.

## Evidence

Live trace (2026-06-05, codey): dropped-messages.json holds 39 records — 9 on 2026-06-05 alone — every one "Handoff to server failed after 3 replay attempts", all timestamped inside fleet-release restart windows (09:51, 10:19, 12:50, 13:13, 13:39, 13:58). Among them: the mentor's coaching messages for the apprenticeship loop, whose silent loss surfaced as the mentee answering some instructions and never seeing others. Pinned by 2 source-guard tests in tests/unit/lifeline/version-skew-recovery.test.ts beside the version-skew exemption tests (healthy-gated increment present, unconditional increment absent, policy colocated with the drop check).
