# Side-Effects Review — Promised-update capture

**Version / slug:** `promised-update-capture`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1. Fixes Echo Bugs topic 10000002488 / fb-43834231-9a6: "Next update by about 7 PM" (topic 137342, 2026-11-07 17:01 PST) was never recorded as a promise, so nothing came back when the session stopped. Root causes (spec `docs/specs/promised-update-capture.md`): CommitmentSentinel only sees user→agent pairs and this was an unprompted update; Action-Claim lane B reads the first 500 characters (the promise was at 704) and has no clock-time pattern; the written rule depends on the session remembering.

Change: two new files (`src/monitoring/promisedUpdateDetector.ts`, pure; `src/monitoring/PromisedUpdateCapture.ts`), one statement in `server.ts` chaining the capture onto `telegram.onMessageLogged`, a promised-update branch in `CheckInReminderReconciler` (late-update text + `resumePromisedUpdate` hook after the stamp), its wiring in `routes.ts` to `telegram.onTopicMessage`, a template line and a `migrateClaudeMd` arm. About +330 source lines, +420 test lines across unit, integration and e2e. Effort: no spec review rounds, one build pass.

## Decision-point inventory

- PromisedUpdateCapture "does this message promise a time" — **add** — signal only: writes a commitment record, blocks nothing.
- PromisedUpdateCapture "a later agent message closes earlier promised-update rows" — **add** — status write on rows this feature created (externalKey prefix `promised-update:`), never on other commitments.
- CheckInReminderReconciler reminder text and post-send handoff — **modify** — only for promised-update rows; other dated rows unchanged.
- Inbound session routing (`telegram.onTopicMessage`) — **pass-through** — reused unchanged, as the dashboard decision handoff already does.

---

## 1. Over-block

No block/allow surface. False-capture cost: a sentence that reads like a promise but is not ("I'll have results by 7 PM if the run finishes") records a row; it only produces output if NO agent message at all follows in that topic by the time + 15 minutes, and then the output is one honest line plus a handoff. Conditional promises are treated as promises on purpose — the user read them as one.

---

## 2. Under-block

- Vague horizons ("later", "soon", "end of day", "this evening") are not captured: there is no instant at which lateness is a fact. Clock times without am/pm and not hh:mm ("by 7") are skipped as ambiguous.
- Only Telegram topics: the seam is `TelegramAdapter.onMessageLogged`; Slack and app conversations are not covered, matching the check-in reminder, which delivers only to Telegram.
- Any later agent message closes the promise, even a short unrelated one. Accepted 80/20: the user did hear from the agent, and a message that restates a new time re-registers.
- A message logged on another machine (topic moved mid-promise) does not close the row on the machine that recorded it, so that machine could post a false "late" line. See §7.
- Fleet: dark until the check-in reminder is enabled there (same gate).
- Time zone: clock times are read in `commitments.promisedUpdateCapture.timeZone`, else the machine's zone. An agent on a UTC machine serving a Pacific user would fire a "7 PM" promise 8 hours early unless that key is set. The reminder text still shows the time as written. Echo's machines run in the operator's zone.

---

## 3. Level-of-abstraction fit

The capture sits on the outbound message log, the one seam every sent message passes through, so it judges what the user actually received rather than the session's final turn text (Action-Claim's input) or user→agent pairs (CommitmentSentinel's input). It produces a row for the existing dated reminder instead of building its own timer or sender, and the resume uses the existing inbound routing (live session, resume, or respawn). Extending CommitmentSentinel was rejected: it is an LLM on a 5-minute cycle that only sees pairs; extending Action-Claim lane B was rejected: its input is not the sent message and its follow-through is the beacon, whose user output is off by default and whose escalation is dry-run.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The regex detector holds no blocking authority: it never stops, edits or delays a message. Its only effect is a commitment record that the existing reminder may act on later, and that action is itself bounded to one line plus one handoff per promise.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

"Does this sentence promise a message by a concrete time" is a narrow, enumerable pattern with a cheap, honest failure mode on both sides (miss = status quo; false hit = one truthful line only if the agent goes silent). It is a floor, not a competing-signals judgment; no LLM call is warranted on every outbound message for it.

---

## 5. Interactions

- **Action-Claim lane B** may also register a `timepromise:` row for "in 30 minutes" phrases with the beacon armed. Beacon user output is off by default, so the user still hears one voice (this reminder). Not shadowed: different externalKey prefixes, separate per-topic caps.
- **CommitmentSentinel**: unchanged; its dedupe is by request text and does not touch these rows.
- **PromiseBeacon**: rows are recorded `beaconEnabled: false`, so no cadence, revival or escalation doubles the reminder.
- **Promise review**: rows with `checkInAt` are reviewed with high urgency; they normally close within hours by the next message, so review load is small. `source: 'sentinel'` with an externalKey skips the duplicate-candidate marking.
- **Reminder exactly-once**: unchanged — attempts counted before send, stamp after; the handoff runs only after a delivered send and failures there are reported, not retried, so it cannot produce a second reminder.
- **Inbound routing**: the handoff is `senderUnverified: true` with no user id, the same shape as the dashboard decision handoff, so it never binds an operator or carries command authority.
- **Closing**: a later agent message counts as the update once it is past the same-report window (5 minutes) or half the promise's lead, whichever is shorter, so "back in 3 minutes" kept on time closes; a message that names a new time closes earlier rows at once (a correction).
- **Message path**: the capture is wrapped in try/catch and runs after earlier observers in the chain; it cannot break logging or delivery.

---

## 6. External surfaces

User-visible: when a promised time passes with no message, one line in the topic ("I said you'd have my next update by 7:00 PM, and I haven't sent it. I'm picking it back up now and will send it next." plus the quoted promise), and the topic's session receives a "[promised update overdue]" turn — it may be respawned to do so. New config keys: `commitments.promisedUpdateCapture.enabled` (override) and `.timeZone`. CLAUDE.md gains one line. No route or payload shape changes.

---

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, following the check-in reminder it feeds: the row is recorded on the machine that logged the outbound message (normally the topic's serving machine) and stamped `ownerMachineId`, and the reminder only fires on that machine (`other-machine` skip), so two machines never both remind. Residual: if the topic moves to another machine before the promised time and the update is sent from there, the first machine does not see it and may post a false "late" line once. Bounded to one line per promise; accepted. No new status surfaces or URLs.

---

## 8. Rollback cost

Live kill switch without a release: `commitments.promisedUpdateCapture.enabled: false` (read per message). Full back-out: revert the commit. Rows already recorded are ordinary pending commitments; they close on the next message, or can be withdrawn; no migration needed. The CLAUDE.md line would remain on agents that migrated; harmless text.

---

## Conclusion

Closes the structural gap behind three missed promised updates by recording the promise from the sent message itself and reusing the existing dated reminder and inbound session routing for the due time. Signal-only, single-fire, kill-switchable. Clear to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (2026-11-09)
**Independent read of the artifact: concern → resolved**

Concerns raised and what was done:
1. Labels and past events ("Status at 14:30: green", "The update at 7 PM failed") were captured and rolled to tomorrow. Fixed: the bare-noun cue now needs by/within/before, and a clock time that passed under 3 hours ago (no explicit day) is not captured. Tests added.
2. A short promise kept on time ("back in 3 minutes", reply at 3 minutes) fell inside the 5-minute same-report window and never closed. Fixed: `countsAsUpdate` uses the shorter of the window and half the lead. Test added.
3. A corrected time sent within 5 minutes left the first row open. Fixed: a message that names a new time closes earlier rows at once. Test added.
4. The handoff could repeat after a sent-but-unstamped reminder. Fixed: the handoff runs only after a successful stamp. Test added.
5. Time zone defaults to the machine's. Documented in §2 and in the template line; `commitments.promisedUpdateCapture.timeZone` sets it.
Checked fine by the reviewer: handoff routing (same shape as the dashboard decision handoff, operator auto-bind skipped, normal inject/respawn path), provenance (replies are `agent`, the reminder itself is `automation`), dedupe, beacon off, error containment, gating.

## Evidence pointers

- `tests/unit/promised-update-detector.test.ts` — the exact 17:01 message resolves to 2026-11-08T03:00Z (7 PM PST); both sides of each boundary; DST and zones.
- `tests/unit/promised-update-capture.test.ts` — real CommitmentTracker: record, dedupe, close on later message, split-message window, reminder text, single handoff, failed handoff, non-promised rows unchanged.
- `tests/integration/promised-update-routes.test.ts` — real route: late-update line + handoff via `onTopicMessage`, idempotent, no pickup claim without a session path.
- `tests/e2e/promised-update-capture-alive.test.ts` — real AgentServer + tracker with the server.ts wiring: captured row is visible and due on the live route.
- `tests/unit/claudemd-promised-update-awareness.test.ts` — template + migration, idempotent.

## Class-Closure Declaration (display-only mirror)

Defect class: "a promise that depends on the session remembering to register it". This closes it for promised times in Telegram messages; Slack/app conversations remain covered only by Action-Claim (noted in §2).
