# Transient Spawn Refusal Class Guard — Plain-English Overview

> The one-line version: a temporary “not now” answer can no longer quietly become “message deleted,” and CI now rejects any new refusal branch that forgets this rule.

## The problem in one breath

When one agent asks another agent for help, the receiving machine may temporarily be unable to start a worker because it is cooling down, has too many sessions, is short on memory, has exhausted a quota window, or cannot launch the worker process. Those are retryable conditions. Historically, each branch decided for itself whether to park the message, and three of six branches got that decision wrong. Two were repaired individually, but nothing stopped a seventh branch from repeating the same mistake.

## What already exists

- **Admission checks** — decide whether a worker may start now. Their thresholds and authority remain unchanged.
- **A bounded holding queue** — retains refused messages while a temporary condition clears.
- **A drain loop** — revisits retained messages on a short cadence and tries delivery again.
- **Truthful session launch** — the lower-level launcher now distinguishes a real pre-delivery launch failure from bookkeeping trouble after the prompt already reached a live worker.

## What this adds

Every retryable refusal is constructed through one preservation funnel. That funnel stores the current message before returning “try later.” The final launch path also treats the existing queue transactionally: it snapshots the backlog for the outgoing prompt but does not remove those entries until the launcher confirms delivery. If launch fails, the old entries keep their original age and order, and the current message joins them at the position and age it had when launch began—not when the failure finally came back.

The compiler now enforces the class rule with a private branded result type: the guarded implementation cannot return a retryable result unless it came from the preservation funnel. A structural test pins the public method to that typed implementation, permits retryable call returns only from the funnel, and rejects casts elsewhere in the class that could evade it through a helper. That is the class-level protection the branch-by-branch repairs lacked. The same test checks the real server boot path constructs this class, starts its drain loop, hands that exact instance to the Threadline router and server, and disposes it at shutdown.

## The safeguards

**Admission stays authoritative.** This does not weaken memory, session, cooldown, or quota checks. Their predicates, reasons, and retry intervals are unchanged.

**A failed launch cannot consume the backlog.** Queue entries remain reserved while launch is in flight. Only the exact snapshot included in a successfully delivered prompt is removed, so messages arriving concurrently remain queued.

**The bounded queue keeps chronological priority.** If a later refusal fills the final global slot while an earlier launch is still awaiting its result, and that launch then fails, the earlier reserved payload displaces the globally newest later entry. The queue stays at the same bound and records truncation; the delayed failure cannot make the earlier message lose the capacity it had on arrival.

**One agent cannot launch twice at once.** A per-agent in-flight reservation prevents overlapping attempts from both copying and delivering the same backlog, even when cooldown is configured to zero.

**A successful launch remains exactly once.** Once the launcher confirms delivery, the snapshot is committed and cannot be drained into a second worker.

**Bad legacy zero-cap configuration cannot hang the process.** Degraded admission is floored at one bounded slot, and runtime updates reject zero.

**The test is wired to production, not a look-alike.** It verifies the actual boot source connects the guarded manager to the Threadline router and lifecycle calls.

## What ships when

The preservation funnel, transactional queue snapshot, in-flight serialization, runtime regressions, compiler/AST ratchet, and production-wiring proof ship together. There is no new configuration, migration, endpoint, or rollout switch.

## What you actually need to decide

Approve making “retryable refusal implies queue admission before return” a structurally enforced class invariant for every `SpawnRequestManager` branch.
