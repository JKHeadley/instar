# A stored Secret Drop copy is deleted after 24 hours instead of staying forever

<!-- bump: patch -->

## What Changed

SEC-157. A submitted Secret Drop is kept encrypted in the secret store so it survives a restart before the agent uses it. Nothing ever removed an unused copy, and the retrieve route's fallback returned one of any age, so a secret the agent never used stayed on disk, retrievable, forever. Now a stored copy older than 24 hours, or with no readable receive time, is gone. That includes undated copies from before store-first persistence. The retrieve fallback deletes it instead of returning it. A sweep removes every expired copy when the server starts and whenever a new secret is submitted. The sweep needs no timer, and it never creates a secret store that does not exist. The in-memory copy keeps its 30-minute cap.

The form no longer says "It is not stored on disk". A normal request now says the secret stays only on this computer until the agent uses it, and never longer than 24 hours. A browser-only request says it is never saved to disk. The thread-history file a Secret Drop session reads at start is now written owner-only.

## What to Tell Your User

- **Old secrets are cleaned up**: "If you send me a secret and I never use it, I now delete my encrypted copy after a day instead of keeping it, and the form tells you exactly that."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stored Secret Drop copies expire after 24 hours | Automatic |

## Evidence

- `tests/unit/sec157-drop-copy-age-limit.test.ts`: the 24-hour boundary, and an unreadable time counted as expired. The sweep removes only expired copies in one write, keeps every other secret, drops the empty branch, and writes nothing when nothing expired. The form wording is covered for both kinds of request.
- `tests/integration/secret-drop-store-first.test.ts`: an expired or undated copy returns 404 and is deleted. Route setup sweeps expired copies and keeps fresh ones. Route setup with no secret store creates none.
- `tests/e2e/secret-drop-store-first-lifecycle.test.ts`: a real server start removes an expired copy and still serves a fresh one.
