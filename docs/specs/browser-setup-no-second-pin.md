---
title: "Browser setup: no PIN when the owner approves on the phone or in Telegram"
slug: "browser-setup-no-second-pin"
author: "Echo"
parent: "docs/specs/dashboard-conversations-browser-device.md"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "docs/specs/browser-setup-no-second-pin.eli16.md"
review-convergence: "2026-11-09T20:10:00Z"
review-iterations: 1
approved: true
approved-by: "Echo (standing spec-approval grant), 2026-11-09 12:10 PST, after one independent security review whose required changes are all in the design; operator instruction topic 134088 2026-11-09 11:06 PST"
---

# Browser setup: no PIN when the owner approves on the phone or in Telegram

## Problem statement

Setting up a browser for dashboard Conversations asks for the dashboard PIN (parent spec §4.2 step 5, "the PIN is asked for at every setup"), and then the owner approves the browser on their iPhone with Face ID or in their private Telegram chat. The operator, 2026-11-09 11:06 PST, topic 134088: "do we really need a PIN approval here since we're already authenticating through telegram or the app?" On an agent with a Telegram owner the PIN never approves anything (parent: "The PIN never approves a browser on an agent with a Telegram owner"); the human approval does. The operator's standing preference is no PIN on dashboard controls (2026-09-27).

## Proposed design

Step 5 of the setup route becomes conditional on the approval path:

- **The Bearer principal is checked first, on every path** (before step 2). It used to be checked only inside step 5's condition, so dropping step 5 would have dropped it.
- **The approval path is read once**, at step 5, and that value is used through step 9.
- **Approval path `telegram`** (a Telegram owner exists; approval is the owner's Telegram tap or code, or an owner phone's Face ID): no operator session is required and **any session header is ignored**. The record's one-setup key becomes `enroll:` + SHA-256 of the `enrollmentId`; a retry of the same setup is still answered by step 4, and a `session-used` refusal on this path answers `409 setup-ended` ("Start it again"), not a PIN message.
- **Approval path `dashboard`** (no Telegram owner): unchanged. The live PIN session is the approval, so it stays required, and step 9 refuses to activate without a verified session.
- **`activate()`** refuses `dashboard-pin` unless it is the setup request's own record, and refuses `owner-agent` for browsers (the parent spec already says introducers never approve a browser; this makes it structural).
- **The device name is untrusted.** Unicode format characters (`\p{Cf}`: bidi overrides, zero-width) are stripped at creation; the owner's approval DM is sent as escaped HTML, never through the markdown converter, so a name cannot become a link or bold text; both versions of the approval message say "(the browser chose this name)". Push alerts never contain it.
- **Abuse bounds on the `telegram` path.** At most one browser setup pending at a time (`409 browser-setup-waiting`); an owner's Decline of a browser pauses new browser setups for one hour (`429 browser-setups-paused`, in memory), the owner's one-tap stop.

Client: when `GET /mobile/browser-devices/status` says `approvalPath: telegram`, setup skips the PIN sheet and sends no operator-session header. If the answer is still `403 operator-session-required` (the Telegram owner was removed in between), the PIN sheet is shown once. The pre-setup line drops "You will be asked for your dashboard PIN".

Unchanged: who can approve (only the owner, by Telegram or owner-phone Face ID, comparing the browser key); `maxSetupsPerHour` (default 6) and `maxBrowsers` (default 10); the stuck-setup sweep; the approval message's "If you did not start this, tap Decline"; activation notice to the owner.

## Decision points touched

| Point | Classification |
|---|---|
| Operator session required at setup | judgment-candidate; floor: on the `telegram` path every activation still needs the owner's human approval with key comparison; at most one browser setup pending, 6 per hour per machine and 10 browsers per machine; a Decline pauses new browser setups for an hour; each approval request says to decline one the owner did not start; on the `dashboard` path the PIN session stays required because it is the approval; arbiter: the owner, who can decline any request or lower `maxSetupsPerHour`; costs accepted: the lockout and one-waiting effects in "What the PIN still bought"; fallback: a 403 asking for the PIN shows the PIN sheet once. |
| Activation via `dashboard-pin` or `owner-agent` for a browser | invariant; basis: the PIN approves only the request that carried it, and introducers never approve a browser (parent spec); `activate()` refuses both otherwise. |

## What the PIN still bought, and why it is accepted

The parent spec already notes the PIN is readable by anything running as the agent's OS user, so it never stopped the agent's own sessions. What it stopped was someone holding only a leaked Bearer token (for example through the tunnel) from starting a setup. Without it, such a holder can cause approval requests to reach the owner. They cannot complete one: activation needs the owner's approval with the browser key compared.

Costs, and their bounds:
- (a) Unwanted approval requests: at most one pending at a time, at most 6 an hour on the lease holder (a lease move gives the new holder its own 6), each with "If you did not start this, tap Decline"; one Decline pauses new browser setups for an hour.
- (b) Lockout of the owner's own setup: junk setups use hourly slots and, while pending, block a new one; the owner clears it with one Decline (which also pauses for an hour) or waits for the 30-minute pending lifetime.
- (c) One-tap approvals switched off: a waiting browser counts toward the one-waiting rule (`another-phone-waiting`), which turns Telegram Approve and Face ID approval into code-only for every phone and browser for that pending lifetime; one pending browser at a time and the decline pause bound how long this can last.
- (d) Wrong-code budget: a Bearer holder with its own key could type wrong codes into the shared budget and pause pairing; a Bearer holder could already do this through phone pairing links, so this is not new.
Accepted on the operator's instruction.

## Multi-machine posture

Unchanged from the parent: setup runs on the machine serving Telegram (machine-local by design, `physical-credential-locality`: the Telegram owner chat is reached through that machine's bot token).

## Review

Independent security review (read-only agent, 2026-11-09 12:00 PST): verdict SAFE WITH CHANGES; no route activates a browser without the owner's approval once the PIN is gone. All required changes are in this design: Bearer check moved first, path read once, header ignored on `telegram`, `setup-ended` instead of a PIN message, `activate()` guards, device-name format-character stripping and HTML-escaped approval DM with the name warning on both versions, one pending browser at a time and the decline pause, and the costs written above.

## Open questions

None.
