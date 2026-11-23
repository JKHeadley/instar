# Side effects: silent computers, "gone for good" and the agent-wide alert (SEC-170, part 3 of 3)

In plain words: the agent lists computers silent for 7 days or more, the owner can retire one or confirm it gone for good from the phone with Face ID, and wrong PIN guesses spread across computers raise one alert. Everything stays under the dev-gated pool-wide PIN budget switch.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size:
- new `src/core/PinGoneForGood.ts` and `src/core/PinOwnerSurface.ts`;
- small edits to `PinAttemptStore`, `PinShareTable` (two optional report fields), `pinBudgetPoller` (parse plus `onReport`), `mobilePermissionsRoutes` (a new `silent-machine` permission action and its route), `mobilePairingRoutes` (its owner-only allowlist rule), `routes.ts` (two bearer routes and the wiring), `AgentServer.ts` and `server.ts` (wiring);
- 1 new unit test file and an extended e2e test.

## What changes for running agents
- **Switch off (the fleet):** no change. The routes answer `enabled: false` or 503, the phone action answers 503 before any Face ID, and the report fields are never sent.
- **Owner phone action.** It is new: `POST /mobile/pin-budget/silent-machine`, permission action `silent-machine` (owner phone only, Face ID over `silent-machine <machineId> <choice> <fingerprint>`, the same write gate as the team actions). Choosing `retire` revokes the computer in the replicated registry, exactly as `instar machines remove` does, by this machine, with the reason "Retired by the owner from the phone". Choosing `gone-for-good` saves a confirmation. Both refuse before any challenge when they cannot succeed, re-check everything after the signature, answer "already" without changing anything when repeated, and report a failed save.
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
The Needs-you entry (source `machine-retirement`, one agent-wide row, "Review computers that have been silent") is written and agreed with the dashboard makeover. The console's first-screen test requires the machines page to lead with that need, and that panel is the dashboard makeover's (`dashboard/console/machines.js`). So the entry lands together with their panel, in their change or stacked on it. It does not land here. The phone screens are the Apple app rebuild's. This commit carries every route they need.

## Signal vs authority
The silent list is a signal: it proposes and never retires anything. Retiring and "gone for good" are the owner's decisions alone, taken on the owner's phone with Face ID over a line that names the computer, the choice and the list version. The confirmation then counts only while the pool's own evidence (7 days of silence everywhere) agrees, per the spec's judgment-candidate floor. The alert never changes what is admitted.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the spec, the design choices and the diff), 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed:
- no new path raises a share, and a non-silent or self confirmation does nothing;
- the SEC-018 change did not weaken other purposes (that change was later removed, see below);
- the report signature covers the new fields;
- the late-bound failure counter is correct.

Its non-blocking points were all addressed before commit. After that review, the phone path was changed from the SEC-018 approval cards to a direct permission action, and "retire" was added. The SEC-018 phone routes are not on the device allowlist, so cards could never be answered from a phone. That change had its own review, recorded below.

- a confirmation must postdate 7 days of silence (stops pre-seeding and re-arming);
- the phone approval fails visibly when the save fails;
- the alert voice excludes older and retired peers;
- a machine that comes back is dropped from the dismissal record;
- tests were added for the signature tamper case, a failed save, pre-seeding and the dismissal comeback.

**Second review (the phone action and retire):** independent Claude Sonnet subagent, fresh context, 2026-11-22. Verdict: CONCUR, no blocking items. It confirmed:
- only an owner phone with Face ID reaches either choice (bearer, team member phones, peers and the dashboard PIN have no path);
- the challenge is single-use and bound to the exact line, so a choice or target swap fails;
- apply re-checks synchronously;
- retire refuses this computer, live computers and already-retired ones, and uses the CLI's own revocation;
- nothing from the removed SEC-018 path is left dangling.

Addressed from its notes:
- retire now waits while some computer's records cannot be read;
- the retire answer carries the CLI's advice to rotate the agent's keys.

Not added: a route-level harness test (replayed challenge, wrong line, team-member phone). Today those paths are covered by the shared, already-tested permission-action machinery.

## Rollback
Revert the commit. The two new state files are ignored by older code. With the switch off, nothing reads them.

## Tests
- `tests/unit/sec170-pin-owner-surface.test.ts` (new).
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts` (two cases added). Not run by hand on the M5 (standing rule); Local Verify runs it.
- The existing sec170 unit files and `mobile-owner-presence` pass unchanged.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. One 60-second check timer, bounded and unref'd, and an alert at most once per 30 minutes.
