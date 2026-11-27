---
title: "Every console warning has a path, checked; iMessage follows its present state"
slug: "warning-paths"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "warning-paths.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-05 08:30 PST: every warning needs an immediately actionable path, app and dashboard) and the coordinator's finishing list. No standards registry edit; the wording of a standard is with Justin."
review-convergence: "2026-11-05T22:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-05T22:00:00.000Z"
review-report: "not applicable: follows docs/specs/mobile-health-issues.md; display, a test floor, and one state read."
---

- **ladder:** not applicable: no off-by-default switch.

## Problem

PR 2808 left three gaps: an unsorted problem's title could be a reporter's raw text; iMessage's "Degraded" cleared after 30 minutes while it was still down, because its failure is reported once and never retried; and warnings on console pages had no structural guarantee of a path.

## Design

**Titles.** A row with no table entry gets a title written here, never the reporter's text, which stays in the details.

**iMessage.** `GET /mobile/health-issues` takes the present state from the server: switched on and not connected is down, connected is up, not switched on is off. Down shows whether or not an event is in the window; up or off drops an old event. Its action opens Remote Desktop, and its words say what the fix is: someone at the Mac allows the program under Full Disk Access, then a restart, or asks to turn iMessage off. A person is required: macOS will not let a program grant itself this.

**Console.** `pageHead` adds "Ask the agent about this" to any warning headline or fact. `askLink` serves warnings with no other action.

**Enforcement.** `tests/unit/console-warning-paths.test.ts` fails on any line giving a tone or state of `attn` or `bad` without a `warning-path:` or `warning-exempt:` comment on it or above it, and checks each claim: a route must be registered, `inline` needs an href or action there, `pageHead`, `row` and `askLink` must exist on the page, and an exemption needs a real reason. Negative controls prove each fault fails. The app has the same check as an XCTest in its own repository.

## Tests

Unit on both sides of the iMessage states and the title rule; integration for down with no event; the console floor with negative controls.
