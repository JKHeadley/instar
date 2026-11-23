# Side effects: silent computers, "gone for good" and the agent-wide alert (SEC-170, part 3 of 3)

In plain words: the agent lists computers silent for 7 days or more, the owner can confirm one gone for good from the phone with Face ID, and wrong PIN guesses spread across computers raise one alert. Everything stays under the dev-gated pool-wide PIN budget switch.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size:
- new `src/core/PinGoneForGood.ts` and `src/core/PinOwnerSurface.ts`;
- small edits to `PinAttemptStore`, `PinShareTable` (two optional report fields), `pinBudgetPoller` (parse plus `onReport`), `mobileOwnerPresenceRoutes` (purpose and per-purpose switch), `routes.ts` (three bearer routes), `AgentServer.ts` and `server.ts` (wiring);
- 1 new unit test file and an extended e2e test.

## What changes for running agents
- **Switch off (the fleet):** no change. The routes answer `enabled: false` or 503, the new purpose stays unavailable, and the report fields are never sent.
- **Owner approval flow (SEC-018).** It gains the purpose `pin-gone-for-good`. That purpose is usable when the PIN budget switch is on, even if `security.ownerApprovedActions` is off. Other purposes are unchanged: their challenge, approve, decline and pending listing still need the general switch. The pending list shows only the purposes switched on. A phone approval whose confirmation cannot be saved now answers 500 with plain words instead of a silent success.
- **Confirmations.** They are saved to `state/pin-gone-for-good.json` (part 2's reader keeps reading its `machines` list) and travel in the machine-signed state report. A receiver adopts at most 64, keeps the newer of two, never adopts one for itself, and ignores one dated more than a minute ahead.
- **When a confirmation counts toward a raise.** Only when:
  - the target had been silent for 7 days when the owner confirmed it;
  - it has not been heard from since;
  - PinShare's pool-wide 7-day silence and complete-records checks also hold.
- **Silent list and dismissal.** The dismissal record is `state/pin-silent-dismissed.json`. A machine that comes back drops out of it, so going silent again later raises the item again.
- **Alert.**
  - Each report carries the machine's wrong unknown-browser guesses from the last hour (kept in memory, so a restart forgets them and only delays an alert).
  - The voice is the lowest id among this machine and the fresh, non-retired peers whose report carries a count. An older or retired machine therefore never silences the alert.
  - It raises the existing `DashboardPin.bruteForce` alert at 20 or more, at most once per 30 minutes. A check runs every minute.
- **Multi-machine posture:** replicated through the signed pull of part 2. Phone device keys are machine-local by their own spec, so a peer trusts the approving member's signed report rather than re-checking the Face ID signature. This is the same trust it gives that member's acknowledgments. The floor bounds a wrong or forged confirmation to the target's old share.

## Still to come in this part
The Needs-you entry (`dashboard/console/needs-model.js`) and a possible phone twin of the request route are being agreed with the dashboard makeover and the Apple app rebuild. The routes they need are in this commit. If neither answers by midday 2026-11-24, the needs entry lands in this pull request in the proposed shape, and the phone uses the generic pending-approvals list.

## Signal vs authority
The silent list is a signal: it proposes and never retires anything. "Gone for good" is the owner's decision alone. The server only registers a pending request with server-written words, and applies a confirmation only after a verified phone approval. The confirmation then counts only while the pool's own evidence (7 days of silence everywhere) agrees, per the spec's judgment-candidate floor. The alert never changes what is admitted.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the spec, the design choices and the diff), 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed:
- no new path raises a share, and a non-silent or self confirmation does nothing;
- the SEC-018 change does not weaken other purposes;
- the report signature covers the new fields;
- the late-bound failure counter is correct.

Its non-blocking points were all addressed before commit:
- a confirmation must postdate 7 days of silence (stops pre-seeding and re-arming);
- the phone approval fails visibly when the save fails;
- the alert voice excludes older and retired peers;
- a machine that comes back is dropped from the dismissal record;
- tests were added for the signature tamper case, a failed save, pre-seeding and the dismissal comeback.

## Rollback
Revert the commit. The two new state files are ignored by older code. With the switch off, nothing reads them.

## Tests
- `tests/unit/sec170-pin-owner-surface.test.ts` (new).
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts` (two cases added). Not run by hand on the M5 (standing rule); Local Verify runs it.
- The existing sec170 unit files and `mobile-owner-presence` pass unchanged.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. One 60-second check timer, bounded and unref'd, and an alert at most once per 30 minutes.
