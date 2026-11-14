# Promises that the agent looks after itself — plain-English overview

## What this is

Every time the agent says "I'll do that later", it writes down a promise. Over three months Echo collected about 735 open promises and never went back to sort them. Some were done long ago. Some stopped mattering when the conversation moved on. A few still matter, and someone is waiting on them. The app showed Justin a list of 200, with the oldest 79 days overdue, and he said it should not be his job to sort them out.

This change makes the agent do that sorting itself, on a regular schedule, and gives every promise a priority so the important ones rise to the top.

## What already exists

- A list of promises, kept on each machine and shared between machines.
- An age-based expiry that would close anything older than 21 days. It is switched to "pretend only", because age alone does not prove a promise was kept.
- A reminder system that nudges the agent about open promises. It never closes them and never ranks them.
- Promise screens in the dashboard and the iPhone app that list everything, with no priority and no filter.

## What is new

1. **A priority on every promise.** There are three levels. High means a person is waiting on something concrete. Normal means real work the agent owns. Low means nice to have. A promise nobody has assessed yet says so honestly, instead of pretending to be "normal".
2. **A review job that runs four times a day.** The agent takes up to 30 promises that have not been looked at in a week. For each one it checks the evidence: the conversation, the code history, the bug tracker. Then it makes one decision:
   - **keep** it,
   - **set its priority**,
   - **mark it done** (it must say what proves this), or
   - **archive** it as superseded, duplicate or obsolete (it must say why).

   It never messages anyone and doesn't do the promised work itself. Instead, high-priority promises sit at the top of what every new session sees when it starts, so they get worked on first.
3. **Rules the server enforces, whatever the job decides.**
   - Nothing closes without a written reason.
   - A high-priority promise, meaning someone is waiting, can only be closed when it points to proof the server can check, such as the agent's own later message in that conversation. Otherwise it stays open.
   - Standing rules ("from now on I will…") are never marked done.
   - A machine only touches its own promises.
   - At most 15 promises close per run and 60 per day.
   - Every decision is written to a log.
4. **Undo.** For 30 days, any promise the review closed can be reopened with one tap in the dashboard ("Undo — reopen"). The log names the run that made each decision, so a bad run can be undone as a whole.
5. **Better screens.** The phone and dashboard show each promise's priority and can filter by it. High priority comes first. Closed promises never count toward the open number. Every open promise has a direct "ask the agent" action. The phone gets no buttons to manage promises, because managing them is the agent's job.
6. **Every new session sees the high-priority promises first,** so the agent keeps getting reminded of them until they are closed.

## Safeguards in plain terms

- Nothing is ever deleted. "Archive" uses the existing "withdrawn" state, and the full record stays.
- A missing or bad decision always fails safe: the promise just stays open.
- The feature is live on Echo first, the development agent, and switched off on everyone else's agents until it has proven itself. Even on Echo it starts in a practice mode for closing promises: it sets priorities for real, but it only *records* what it would have closed. Closing for real begins once those records show it judges well, meaning fewer than 1 in 20 of its would-be closes turn out wrong. Turning it off takes effect immediately and needs no restart.
- Echo's existing pile of 735 was sorted by hand on 2026-11-06. 538 were closed, each with a written reason, so the practice mode costs Justin nothing.
- The sentinel used to record one reply as two or three identical promises. It now marks each extra copy as a likely duplicate, so the review can archive it after checking.
- On a machine where it is off, or where nothing needs review, the job never starts a session, so it costs nothing.

## What the reader needs to decide

Nothing is waiting on a decision. The choices that could have needed one are fixed in the spec:

- three priority levels,
- archive means "withdrawn",
- no deletes,
- live on Echo and dark on the fleet,
- every 6 hours, with 30 reviews and at most 15 closures per run,
- no promise management from the phone.

The one later decision is when to switch it on for all agents. That comes after Echo's soak shows the closures are right, which we check by reading the review log and seeing how often promises get reopened.
