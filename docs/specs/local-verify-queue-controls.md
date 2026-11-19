---
title: "Local Verify: hold a change and move a change to the front, without a restart"
slug: "local-verify-queue-controls"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "docs/specs/local-verify-merge-authority.md"
eli16-overview: "docs/specs/local-verify-queue-controls.eli16.md"
tier: 2
supervision: tier0
topic: 145097
---

# Local Verify: hold a change and move a change to the front, without a restart

## Words used here

- **Change:** a pull request waiting to be merged.
- **Local Verify, "the line":** the system that tests every change before it may merge. It runs on two of our computers: the Studio, which is the **coordinator** and owns the queue, and the M5, a **peer** that the coordinator hands changes to.
- **Verify:** one test run of one change, 20 to 40 minutes.
- **The queue:** the changes waiting for a verify, on the coordinator. It has a size limit (the **cap**); a change refused because the queue is full goes on a **waiting list**, oldest refusal first, and is admitted when a place frees.
- **The watcher:** the part of the server that, about every ten minutes, asks for a verify for each open change in its scope that has no result yet.
- **The operator:** whoever runs the line. Today that is an agent session (the throughput session); it could be a person.
- **Main verify:** a test run of the shared code itself, after changes merge. When the oldest unverified merge is 90 minutes old, the main verify is **due** and gets the next start.

## Problem

The operator of the line sometimes needs to change what the queue does next:

- put one change first, because it was promised or because it unblocks many others;
- keep a change from being tested for now, because it is known to be wrong or is waiting on something.

Neither exists. The only way today is to edit the queue's file by hand and restart the server. A restart throws away the verifies that are running on both machines.

**Measured from the Studio's audit log** (`logs/local-verify.jsonl`, days from 00:00 PST):

| Day | Studio restarts | Studio verifies interrupted | Studio minutes thrown away | M5 verifies abandoned on a restart |
|---|---|---|---|---|
| 2026-11-16 | 4 | 0 | 0 | 3 |
| 2026-11-17 | 14 | 4 | 63 | 8 |
| 2026-11-18 | 24 | 9 | 74 | 8 |

The audit log does not record why each restart happened. The operator's own approximate account of the 24 on 18 November (agent message 163c8ee2, 2026-11-18 23:10 PST): "about 9 were installs of a new build ... about 9 were reorder-only (put a promised or blocking PR first, or take entries out), 2 or 3 were config changes ... and the rest were pairs where an install restart was followed by a second restart within minutes to fix order".

That evening a change that unblocked fourteen others (PR 3489) and a repaired change both had to go first. Neither was in the queue, because the queue was full, so each needed the file edited and a restart.

One more gap showed the same evening. The GitHub label `do-not-merge` stops a change from being merged and from being newly requested, but the queue never reads it: a change that is already queued still starts and uses a verify.

**Expected benefit, and what it rests on.** On 18 November the 24 restarts threw away 74 Studio minutes, plus M5 time that the log gives only as 78 minutes for all abandoned M5 verifies that day (restarts and other causes together). If reorder restarts cost the same as the average restart, removing 9 to 12 of 24 saves roughly 30 to 60 machine-minutes a day: about 1 more merge a day at the measured 0.48 merges per verify. That is a projection with those conditions, and it is small. The larger benefit is time: a blocking fix reaches the front in seconds with no verify lost. Both are measured after shipping (see Maturation plan).

## Proposed design

Two controls, each an HTTP route on the coordinator, each taking effect at once with no restart: **hold** and **front**. Neither touches a verify that is already running.

A third control in the first draft, "remove", is dropped. Review showed that a hold which takes the change out of the way does the same job, and that a separate removal could be undone by the service's own re-requests.

Both controls are off unless `monitoring.localVerify.queueControls` is `true` on that machine (absent means off; the routes then answer 404). Local Verify itself runs only on development machines; this switch keeps the new routes off everywhere until an operator turns them on.

### What the controls remember

The operator's choices are kept per change number, not per queue entry, in one small file, `state/local-verify/operator-queue.json`, written atomically (a temporary file, then a rename). A queue entry is rebuilt when a change gets a new push, when it is requested again and when the server restarts, so a choice stored on the entry would be lost; this was verified against the code, which overwrites an entry's priority on every re-request. Everything that orders or starts work reads the choices from this file's in-memory copy at the moment it decides.

- **Size.** At most 200 changes. When a record would be the 201st, records of changes that GitHub reports closed or merged are dropped first; if 200 live records remain, the request is refused (`operator-file-full`) and existing records are kept. Closed changes are also dropped whenever the service learns a change is closed.
- **Unreadable file.** The file is moved aside and the service first repairs itself: it rebuilds the holds and front marks from its own audit rows of the last 14 days (every hold, release, front and unfront is audited). If that works, one audit row records the repair and nobody is told. If the audit log cannot be read either, the service continues with no holds and no front marks, because it cannot know them, and says so at once: one audit row and one attention item stating that operator holds were lost and must be set again. Starting work on an unknown is chosen over stopping the line because a hold only delays testing; stopping a wrong change from merging is the job of the merge-side hold (below).
- **Two files, one order.** A hold is written to the operator file before the entry leaves the queue. A release is written as "releasing" before the change is re-admitted, and cleared after the queue file holds the entry; a restart in between finishes the release at boot. One rule covers every other gap: whenever the service finds a queue entry for a held change, at boot or when it next looks for work, it moves that entry to held.
- **The switch.** With the switch off, stored holds and front marks are kept but not applied: changes are admitted and ordered as if the file were empty. Turning it on applies them again.

### A. Hold: `POST /local-verify/queue/hold { pr, reason, until?, blockMerge? }` and `POST /local-verify/queue/release { pr }`

- **A held change is out of the queue.** If it is queued, its entry is taken out and its place is freed for the waiting list, which fills it in its usual order (oldest refusal first). If it is on the waiting list, it is taken off it. The hold record keeps the time the change first queued. While held, a request for that change, from the watcher or anyone else, answers `held` and admits nothing. So a held change does not start on the coordinator, is never handed to the peer, does not count toward the cap, and is not counted as waiting work by the "starved" alarm.
- **A change may be held before it is queued,** with the same effect.
- **If the change is running** when the hold arrives, here or on the peer, the answer says so (`running: true`) and the run is left alone. If that run later ends without a result and would be queued again (an interruption, an error re-run, a peer hand-off abandoned on a restart), it goes to held, not back to the queue.
- **The moment of decision.** The service picks an entry, then waits on a base refresh before starting it or reserving it for the peer. After that wait it checks again, at the point of starting or reserving with no further wait: a held entry is not started, and if another change now ranks first (one fronted during the wait), the picked entry gives way and the choice is made again.
- **Release** puts the change back in the queue with its original first-queued time, so its ageing priority is what it would have been, minus the time it was held. If the queue is full, release still admits it, within the operator overflow (below). Releasing a change that is not held answers `not-held`.
- **A new push** to a held change changes nothing; when released it is tested at its newest commit, as any entry is today.
- **Hold and merging.** A hold stops testing, not merging: if the change already has a passing result it could still merge. With `blockMerge: true` the same request also applies the existing merge-side hold (the `[HOLD]` marker, through the same function `POST /green-pr-automerge/hold` uses, with the reason cleaned the way that route cleans it), so one request carries the whole intent. If GitHub refuses, the queue hold still applies and the answer says the merge-side hold failed. The answer states which of the two were applied. Release does not remove the merge-side marker; the answer says so.
- **Seeing holds.** `GET /local-verify` lists held changes with reason, time and `until`.
- **A forgotten hold.** A hold lasts until released. `until` is an optional date the operator expects to release by. The coordinator checks hourly. When a hold has passed its `until`, or 24 hours with none, it raises attention **once** for that hold; holds found due at the same check are reported in one item (the item's id carries the check time). A held change that has closed is dropped, not reminded. After that one reminder an overdue hold is not raised again; it stays listed in the queue view with its age, and the 7-day review lists every hold older than 3 days.
- `reason` and `by` (the name of the session or person asking) are required; `reason` up to 500 characters, shown in full in the queue view. `by` is written to the audit row. It is a label for the record, not a proof of identity: the routes trust whoever holds the server's credential, as the existing routes do.

### B. Front: `POST /local-verify/queue/front { pr }` and `POST /local-verify/queue/unfront { pr }`

- **The named change is the next change to start.** If several are fronted, the most recently fronted goes first.
- **A change that is not queued is admitted by this call,** even when the queue is full, within the operator overflow (below), audited (`front-admitted-over-cap`). Without this the control would fail in its most common case; on 18 November both changes that had to go first were outside a full queue.
- **At most 3 changes are fronted at a time.** A fourth request answers `front-limit` and names the three. This keeps a stream of fronts from pushing ordinary changes back without end.
- **The operator overflow.** Changes admitted over the cap by a front or a release share one budget: 5 places over the cap, counted for as long as those entries are in the queue. When it is used up, a front answers `overflow-full`, and a release puts the change at the head of the waiting list instead, so it takes the next free place. The number of entries restored at boot is raised by the same 5, so nothing admitted this way is dropped by a restart.
- **How order is computed.** The front mark is a rising number kept in the operator file. Where the service orders the queue (one sort, used by both the coordinator's own choice and the hand-off to the peer), a fronted change sorts ahead of every other change, highest number first. Nothing is written into the entry's priority field.
- **When the mark ends.** When the change gets a result for its current commit, pass or fail, whether from a verify that ran or from a result the service derived without running one; or on `unfront` (the entry stays queued at its ordinary priority); or when the change closes. Not when the verify starts: a run that is interrupted, re-run for an error or abandoned by the peer must still come back first.
- **Front and the main verify.** A fronted change goes before a main verify that is waiting but not yet due. When the main verify is due, at most one fronted change starts ahead of it; then the main verify starts. The count is kept in memory beside the existing "last start was the main verify" flag and resets when a main verify starts or the server restarts. One existing rule still goes before a fronted change: a verify that was interrupted by a restart resumes first. So in the worst case a due main verify waits for one resumed verify and one fronted verify.
- **Front passes no gate.** It changes order among changes that may start. An update pause, a memory hold, the main-red hold and the verifier hold apply as before.
- **Front and hold together.** A held change may be fronted; it stays held, and is first when released.
- **A new push** to a fronted change keeps the mark; it is tested at its newest commit.
- **Running.** Fronting a change that is running answers `running` and records the mark, which matters only if that run comes back without a result.

### Who may use them, and the record

- The routes use the same checks as the existing Local Verify routes and the existing merge-side hold route: the server's credential, and the rule that only the machine holding the coordinator lease answers (others answer 409).
- Audit rows: `operator-hold`, `operator-release`, `operator-front`, `operator-unfront`, `front-admitted-over-cap`, `release-admitted-over-cap`, `operator-hold-due`, `operator-file-unreadable`, each with the change number and, for hold, the reason. `operator-front` and the later `started` row for that change (or the derived result, reported separately) give the time from a front request to its start.
- The awareness entry `src/data/awareness/local-verify-queue-controls.md` tells the agent the two controls exist, when to use each, that `blockMerge` covers "do not test and do not merge", and that a restart is no longer needed to reorder. Its title is under 40 characters, because every entry title is listed in the core instruction file.

### What is deliberately not here

- No control cancels a running verify. Interrupting a run is the cost this design exists to avoid.
- The `do-not-merge` label does not become a queue hold automatically. Labels arrive from GitHub with a delay and are set for many reasons.
- **Install restarts,** the other half of 18 November's restarts, are not addressed here. The next design is a restart that waits until both machines are between verifies, or starts nothing new for a bounded time and then goes. It is recorded as the next lever in the scaling plan.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a change may be queued or started while held | invariant; basis: enumerable-domain; evidence: the change number is in the operator file's hold list or it is not. A hold is an explicit operator instruction with a reason, not an inference. Checked at admission and again at the moment of starting or reserving. | |
| What happens when the operator file cannot be read | invariant; basis: enumerable-domain; evidence: rebuilt from the service's own audit rows; if that also fails the state is unknown and is reported as unknown at once (audit row and attention item), and the service continues without holds because a hold only delays testing. | |
| Which change starts next (front) | invariant; basis: enumerable-domain; evidence: a rising number compared at the one sort; it changes order among changes that may start, passes no gate, and is bounded against a due main verify at one. | |
| Whether a fronted or released change may enter a full queue | invariant; basis: enumerable-domain; evidence: a shared budget of 5 places over the cap, counted; at most 3 changes fronted at once. | |
| Whether a control applies to a running verify | invariant; basis: enumerable-domain; evidence: never. Running means in flight here or reserved by a peer. | |

## Fixed limits

| Limit | Value | Reason |
|---|---|---|
| Changes remembered in the operator file | 200, closed changes dropped first, then refused | Holds can be set before queueing, so the queue's size does not bound them; 200 is far above any use seen and keeps the file small |
| Reason length | 500 characters, shown in full | Room for the dependency and the release condition |
| Hold reminder | once, at `until` or at 24 hours, checked hourly | A hold is deliberate; one reminder covers a forgotten one without repeating. The operator sets `until` when a different date is right |
| Changes fronted at once | 3 | The operator fronted at most two at once on 18 November |
| Operator overflow (front and release together) | 5 places over the cap | Equal to the existing labelled overflow; counted while the entries are queued; boot restores that many more |
| Fronted changes ahead of a due main verify | 1 | Keeps the 90-minute main-verify promise within one verify |

## Multi-machine posture

- `operator-queue.json` (on the coordinator): machine-local. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: the queue belongs to the machine holding the coordinator lease and its files are machine-local). The limit this leaves is stated plainly: if the coordinator lease moves to another machine, that machine cannot read this file and starts with no holds, as it starts with no queue. A machine that acquires the lease and finds holds in its own file from an earlier period keeps them and writes one audit row listing them. The coordinator role has not moved off the Studio in normal running.
- The peer needs no change: a held change is never handed to it, and it receives changes in the coordinator's order.
- The hold reminder is raised by the coordinator only.

## Maturation plan

- **ladder:** local-verify-queue-controls
- **test-agent-live:** a throwaway agent with a fake pull-request source and the switch on: hold a queued change and see its place filled from the waiting list and the change not start; hold arriving during the base refresh; release into a full queue; front a change that is outside a full queue and see it admitted and started next; three fronted in a row with a due main verify, and the main verify starting after one; restart the throwaway and see holds and front marks still in force; a corrupted operator file reported at once.
- **dev-agent-live:** the development agent's line, with the switch turned on by the throughput session on the Studio.
- **graduation criterion:** over 7 days on the development agent: the controls were actually used at least 5 times (audit rows; a quiet week proves nothing); restarts made only to reorder or to keep a change out fall to zero by the operator's log; no change starts while held (audit rows); the time from each front request to that change's start is reported; restarts and interrupted verifies per day are compared with the three days in this document.
- **fleet:** after the 7-day review the owner proposes the fleet default with the evidence, and the decision is recorded on the ladder. Until then the switch is off by default and a fleet agent that runs Local Verify may turn it on itself.
- **dark-window:** from merge until the throughput session sets the switch on the Studio.
- **owner:** echo (scaling session, topic 145097). Review at 7 days after the switch is turned on.

## Tests

- **Unit** (the existing fake-clock service harness):
  - Hold: a queued change leaves the queue and its place is filled from the waiting list; it does not start locally and is not dispatched to a peer; hold before queueing; the watcher's request answers `held`; a hold arriving between the pick and the start, for a local start and for a peer reservation, in both orders; a running change is left alone and goes to held if it comes back without a result (interruption, error re-run, abandoned peer attempt on a restart); release restores the first-queued time and excludes held time from ageing; release into a full queue; a new push while held; `blockMerge` calling the merge-side hold; the starved and stalled alarms ignoring held changes while a genuinely stalled runnable change still raises; one reminder at `until` and at 24 hours, aggregated, never repeated; survival across a restart.
  - Front: ahead of labelled and aged changes; most recent first; the mark surviving a re-request, a new push and a restart; admission over the cap up to 3 and the 4th refused; ended by a result and not by a start; back at the front after an interruption, an error re-run and an abandoned peer attempt; before a waiting main verify, and at most one ahead of a due one across the 90-minute boundary; no global gate passed; front on a held change.
  - The file: the 201st record with and without closed changes to drop; unreadable file reported at once and holds absent; switch off means 404 and no effect.
- **Integration:** the four routes through the real router: bodies, refusals, the 409 on a machine without the lease, the 404 with the switch off, and `GET /local-verify` showing held and fronted changes.
- **E2E lifecycle:** on the production wiring with the switch on: the routes answer 200 (not 503 or 404), a hold stops a start, a front admits into a full queue, and the operator file is written where the server reads it. A wiring test checks the operator store is one real object shared by admission, the start check and the dispatch check.

## Risks

- **A forgotten hold** keeps a change untested. It is listed in the queue view and reminded once.
- **Fronting used often** makes the queue less fair to changes that have waited. Every use is audited, and the 7-day review counts them.
- **Held changes outside the cap** could accumulate; the 200-record limit bounds them and the queue view lists them.
- **Lease change** loses holds (see posture).
- **Unreadable file** loses holds; reported at once.

## Frontloaded Decisions

1. Two controls, hold and front. No remove, and nothing cancels a running verify.
2. Choices are stored per change number in `operator-queue.json` and read at decision time; nothing is stored in an entry's priority.
3. A held change is taken out of the queue and the waiting list and is not admitted; release re-admits it with its original first-queued time, within the operator overflow, else at the head of the waiting list.
4. Hold stops testing only; `blockMerge: true` also applies the existing merge-side hold.
5. Front admits a change that is not queued, within the operator overflow of 5; at most 3 changes fronted at once; the mark ends at a result (run or derived), not at a start; at most one fronted change goes ahead of a due main verify.
6. The routes use the existing Local Verify route checks and are off unless `monitoring.localVerify.queueControls` is true.
7. An unreadable operator file is rebuilt from the audit log; only if that fails are holds and front marks lost, reported at once by an audit row and one attention item.
9. A phone or dashboard surface for these controls is a later change; this one ships the routes and the agent's awareness of them.
8. Reminders: once per hold, aggregated, at `until` or 24 hours.

## Open questions

*(none)*
