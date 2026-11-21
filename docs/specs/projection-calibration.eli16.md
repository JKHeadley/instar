# Projection Calibration — Plain-English Overview

> The one-line version: every time an Instar agent says how long something will take, the estimate is written down with the conditions it was made under, the real time is filled in from outside events when the work lands, and the agent sees how far off it has been before it tells anyone the next estimate.

## The problem in one breath

Agents guess at timelines as if they were a human team, and nobody checks the guess afterwards. On 2026-11-17 a carefully reviewed plan said the Windows app would take 4-6 weeks; Justin expects 24-48 hours of autonomous work. Whoever is right, nothing in Instar today could have told the agent it was off before it wrote the number, and nothing will remember the result.

## What already exists

- **Done checks.** The Chief of Staff can already read from GitHub whether a pull request has merged.
- **Approval cards.** The Work Board records when the agent asked a person something and when they tapped.
- **A record of who really said what.** Messages are logged with whether a person or the agent wrote them.
- **A usage record.** Every model call is logged with its model, tool and machine.
- **A check on outgoing messages.** Each message is looked at before it is sent.
- **Opt-in fleet numbers.** Agents whose owners turned telemetry on send a small list of counts to the Instar maintainers.

None of these records an estimate, and none compares one with what happened.

## What this adds

A ledger of projections. When an agent is about to give a time estimate, it first writes its own guess down. The reply to that shows its track record for this kind of task. Only then does it tell the person a number. When the work is finished, the real time is filled in automatically from an outside event. The gap between guess and result becomes the correction the next estimate starts from.

- Each estimate records the conditions. The agent declares which model designs and which builds, how many sessions run in parallel and how many review rounds. The server fills in the rest itself: autonomous or interactive, the tool, the machine.
- Each estimate has one finish line that a machine can check: a pull request merged, or a person confirming.
- A person's estimate can sit beside the agent's on the same finish line. Justin's "24 to 48 hours" and the plan's "4-6 weeks" will be scored by the same event.

## The new pieces

- **The projection ledger.** One shared record across all of an agent's machines.
- **The hourly reconcile.** Once an hour it reads GitHub, the approval cards and the message log, and fills in real times with the time the event actually happened. It does not depend on the agent remembering, and it catches up on anything that happened while a machine was off.
- **Waiting, shown separately.** Time spent waiting for a person's answer is measured from the approval card (asked at, answered at). Time a pull request sat open is shown beside the result. An estimate can be "elapsed" (wall-clock) or "net" (not counting the wait for a person), and the two are never mixed.
- **The calibration read.** For a kind of task it returns: "your estimates like this took 0.4 times your first guess, from your last 14 that finished, ranging 0.2 to 0.9; such tasks actually took a median of 2.6 hours; 2 more are still open and late". It always says how many examples it rests on and whose they are. It is advice; the agent can disagree.
- **The session-start line.** Every new session is told to record before estimating, and how many of its projections are open and late.
- **The unrecorded-estimate note.** If a message contains an estimate that was not written down, the agent gets a note after the message is sent, telling it how to record it. Nothing is held back.
- **The fleet prior.** A small file of numbers shipped with each Instar release, so a brand-new agent starts from what other agents measured, clearly labelled as not its own history.

## The safeguards

**The agent cannot grade its own work.** Only finishes confirmed by GitHub or a person feed the correction. "I say it's done" is kept and shown and does not count. A confirmation tapped with the dashboard PIN does not count as a person, because an agent can hold the PIN.

**The first guess cannot be bent by the correction.** The agent's own guess is on record before the server shows it any track record.

**A re-estimate cannot hide a miss.** If the agent says "4-6 weeks" and a day later says "two more hours", the result is scored against the first number. Changing what "done" means is counted separately and never scored against the old finish line.

**Stalled and dropped work stays visible.** Late open tasks are listed beside the averages as "at least this late". Closed tasks are counted, before and after their due time.

**Padding is not rewarded.** Accuracy is closeness. Finishing in half the time scores the same as taking double.

**A missing measurement is never treated as zero.** If the wait for a person was not recorded, the "net" result reads unknown.

**Nothing private leaves.** Task descriptions, project names, people and machine names never leave the agent. Other installs send numbers only if their owner turns on a separate switch, and their numbers are published only when at least three installs contributed. The spec says plainly what that rule does and does not protect.

**Nothing is blocked and nobody is paged.** Every part informs. No message is held, no estimate is rewritten, and no new alerts reach the operator.

## What review changed

Five rounds of review by Claude, GPT and Gemini reviewers made the design smaller and stricter. Removed: a meter for "agent working time" that could not be measured honestly, finish lines the agent could satisfy by itself, subtracting waits the agent declared, checking web pages, a verification-passed finish line, and two extra ways of catching unrecorded estimates. Added: old misses fade (the correction uses the most recent results, with all-time shown beside), and re-estimates are scored against the first number.

## What ships when

1. The ledger, automatic real times, waiting shown separately, and a dashboard page. The Windows app and this standard's own estimate are the first rows.
2. The calibration read, the session-start line, the note, and the first fleet file, built from Justin's own agents.
3. Numbers from other installs.

Each step is its own reviewed change and is useful alone. It is on for development agents first.

## What you actually need to decide

Approve this standard as written, so step 1 can be built? Your yes also covers one thing worth naming: the first fleet file will contain numbers (no text) from your own agents' estimates and will ship in public releases. Nothing is built before your yes.
