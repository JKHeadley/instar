# Read-only standby scheduler startup containment — ELI16

An Instar agent can run on two machines while only one machine holds the fenced
lease that permits shared-state writes. The other machine is a read-only
standby. During a real single-agent CROSS-MACHINE enrollment test, the new
standby started normally, learned that the laptop held the lease, and correctly
made its shared state read-only. A few seconds later its scheduler noticed jobs
that had been missed while the Mini was offline. It tried those jobs, their gate
checks failed, and the scheduler attempted to record the skips in shared state.
That write was correctly refused—but the refusal escaped the startup task and
terminated the whole server. The supervisor restarted it, producing the same
crash again. A healthy standby therefore could not remain online long enough to
serve health checks, appear honestly in the pool, or receive a transferred
conversation.

The fix restores the invariant that a read-only standby does not run scheduled
jobs. Every job already passes through one `triggerJob` boundary, so that
boundary now checks the authoritative `StateManager.readOnly` state before any
gate, spawn, job-state update, or event append. If the machine is a standby, the
job is recorded only in the scheduler's machine-local skip ledger and returns a
normal `skipped` result. No shared write is attempted and the server stays up.
Because lease demotion can race a job already crossing that boundary, the cron
callback and delayed startup-missed callback also contain trigger failures;
the fenced write still refuses, but its rejection cannot terminate the server.
The lease holder is unchanged: it remains writable and runs the same jobs as
before. This does not infer ownership from a hostname, clock, or network guess;
it consumes the fenced lease outcome already enforced by StateManager.

The regression test recreates the important sequence: load a never-run job,
demote the machine to read-only, trigger the startup-missed path, and prove it
returns `skipped`, spawns no session, and records exactly one local skip. A
second case demotes while a gate is in flight and proves the missed-job
evaluation settles without escaping a rejection. The existing role-guard suite
remains green, and TypeScript compilation is clean.
