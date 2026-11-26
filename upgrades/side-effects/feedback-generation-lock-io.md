# Feedback generation lock I/O

A feedback source append or compaction still uses exclusive creation and writes its PID synchronously before entering the critical section. A same-host peer reads the PID via the same kernel. A process crash leaves that kernel state available and a host crash terminates the owner. Recovery already treats a fresh incomplete lock record as held. The lock needs coordination visibility. Feedback data, generation files, manifest and directory still use their existing durability flushes.

The performance control on a laptop passed three clean runs. An instrumented passing run measured 600 temporary lock flushes taking 2.68 seconds in total. The regression covers the data file inode and verifies the lock is released. Scope is contention mitigation. The existing stale lock reclaim race and acquisition deadline are unchanged.

## Second-pass review

**Reviewer:** peer_gate_design_review, independent source review.

Concur. The synchronous PID remains visible before the protected operation. Append and compaction retain their durable data writes, and the regression distinguishes the feedback data file from the transient lock.
