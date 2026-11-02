# Why a 24-hour run sat idle, and the fix (plain English)

## What happened

When Echo starts a long autonomous run, the session tells the server "watch this run for me" by sending a small request with five names in it: which window this is, which topic, which run, which lifecycle, and which session is doing the work. The server uses that to decide when the run is truly alive, and only then lets the session's "keep working" hook hold it to the task.

On 1 November, topic 131439's session wrote one of those names wrong (`runId` instead of `autonomousRunId`) and left another out. The server's check only looked at whether each value had the right shape of letters and digits. A missing value in JavaScript turns into the word "undefined" when you check it that way, and "undefined" has the right shape. So the server accepted it, went looking for a run literally called "undefined", didn't find it, and refused with a confusing error. The run never started being watched, the "keep working" hook never engaged, and the session sat idle for about four and a half hours.

It was first thought that another topic's run was blocking this one. That turned out not to be the case: the earlier run was already finished, and finished runs don't block new ones.

## What already existed

The server already refused values with the wrong shape, already refused a second live window, and already let a new window replace a finished one.

## What is new

- The server now checks that each name is really present, and if one is missing it says which one.
- If a request uses a name the server doesn't know, it says so and suggests the right one ("runId: did you mean autonomousRunId?"), and lists the five names it expects.
- The agent instructions now show the exact request to send, so sessions stop guessing. Existing agents get this line when they update.

## Safeguards

Nothing about how runs are judged alive changes. A request that was correct before is still accepted. Only requests that were already broken now get a clear message instead of a confusing one.

## What you need to decide

Nothing. This is a small, fully reversible fix: undoing the change restores the old behavior exactly.
