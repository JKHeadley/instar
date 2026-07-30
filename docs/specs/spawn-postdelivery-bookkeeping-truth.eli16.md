# A Delivered Spawn Must Not Report Failure — Plain-English Overview

> The one-line version: once a new agent session is alive and already has its instruction, a failure to save the monitoring record must be reported as degraded bookkeeping, not as a failed delivery that invites the same instruction to run twice.

## The problem in one breath

Starting a headless agent session happens in two distinct moments. First, the system creates the live terminal process and puts the full instruction into its launch command. Then it writes a small session record so dashboards, limits, and cleanup logic can track that process. The second step can fail even though the first one already succeeded. Until now, that bookkeeping error escaped as a generic spawn failure, so a caller could reasonably retry work that was already running.

That ambiguity blocked the safe completion of the adjacent message-loss repair. Putting a supposedly failed message back into the retry queue is safe only when it truly was not delivered. If the session was already alive, retrying can create two agents acting on the same instruction.

## What already exists

- **A truthful launch boundary** — failure while creating the terminal session already throws and remains a real spawn failure.
- **A session-state record** — after launch, the system stores the session identity and monitoring metadata.
- **Visible degradation reporting** — operational failures can be surfaced without pretending the primary action failed.
- **A retrying message queue** — transiently refused agent-to-agent work can wait for another attempt, but it must never requeue work that was already delivered.

## What this adds

The post-launch state write is now explicitly treated as bookkeeping. If it fails, the system logs and reports that degradation, returns the already-live session to the caller, and does not emit a false failure signal. The launch path itself is unchanged: if the terminal session cannot be created, the method still throws.

A regression test proves the exact boundary. It forces the state write to fail after capturing one successful terminal launch, then verifies that the prompt appears in that single launch, the session remains live, and the method resolves instead of rejecting. The test was run before the implementation change and failed on the escaped state-write error; it passes after the fix.

## The safeguards

**No delivery retry is invented.** The change does not queue, resend, or recreate anything. It only prevents successful delivery from masquerading as failure.

**Real launch failures remain loud.** The existing terminal-creation error boundary is untouched. A failure before the process exists still rejects exactly as before.

**The degraded state remains visible and actionable.** The bookkeeping exception is not swallowed silently. It produces both a direct error log and the existing structured degradation report with the exact session id and terminal-session name. That report states the full consequence: the live process is outside normal monitoring and automatic reaping and can survive a restart until it is cleaned up manually.

**The interactive reroute path is unchanged.** That path saves state before it injects the prompt, so its state-write failure does not prove delivery. Applying the same rule there would be dishonest.

## What ships when

This is one narrow runtime fix with one discriminating regression test and no configuration, migration, endpoint, or rollout flag. It can be reverted as a single code change and leaves no new durable state.

## What you actually need to decide

Nothing: this closes a false-failure defect by making the return value match the delivery event that has already happened.
