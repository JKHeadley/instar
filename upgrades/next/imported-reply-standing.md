# Upgrade Guide — NEXT

## What Changed

A Telegram reply that a session wrote, that failed with a temporary error and was queued, is now retried as that session's reply. Recovery already matched the queued row to the live session that wrote it; the last check before sending only recognised replies sent directly by a session, so the retried reply was filed in the quiet feed and never reached the person. Now a queued row attributed to a live, non-job session carries the same reply standing as a direct send: it goes to its own topic and the quiet gate lets it through. A row with no session attribution, and any row from a job session, stays quiet exactly as before. A queue row recorded in the quiet feed is now labelled `quiet-recorded` instead of `delivered-tone-gated`.

## What to Tell Your User

- **Retried replies arrive**: "If one of my answers hits a temporary error and gets retried, it now reaches you as my answer instead of being filed quietly."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A queued session reply keeps its reply standing when recovery sends it | Automatic |

## Evidence

Feedback fb-4fef846e-92e: 12 replies between 2026-11-06 15:50Z and 2026-11-07 18:43Z ended `suppressed` with hold reason `quiet-notification-recorded` and no Telegram attempt. Unit tests in `tests/unit/telegram-origin/origin-service.test.ts` ("an imported queue row under the notification gate") fail on origin/main and pass with this change.
