# Asynchronous monitoring ticks

Tier 1. The affected reads keep their interfaces and can be rolled back by reverting the code. Because the orphan and wedge paths can lead to recovery, an independent second pass reviews action ordering and unavailable evidence.

- Over-block. A busy capture or timeout can defer a finding until a later tick. Recovery needs current evidence and a tracking or ownership change keeps the process.
- Under-block. The change covers the monitoring stacks observed in the post-restart profile. Health can still slow down due to host pressure or other code paths.
- Layer. Terminal capture uses the existing bounded asynchronous SessionManager executor. The reaper scans through a bounded child call. Each monitor owns its own overlap guard.
- Signal and authority. A capture or process scan only supplies evidence. Existing recovery eligibility checks, ownership checks and the ReapAuthority path remain in use, as required by docs/signal-vs-authority.md.
- Interactions. Per-monitor serialization avoids building a backlog. Output trackers preserve their last observation on a failed read. Summaries re-check privacy and session identity after awaited work. A stopped reaper poll discards late results and cannot start a new signal.
- External surfaces. Health stays responsive while these monitors await children. A run can briefly report older monitoring information after a timeout.
- Multi-machine posture. Monitoring and reaping use each server's local process and terminal views. No change to leases, replication, or cross-machine message ownership.
- Rollback. Revert the source change. There is no migration, persisted format change, or setting to remove.

## Second-pass review

The independent first review identified action-time tracking, stop invalidation, unavailable captures, and summary privacy as required corrections. The follow-up review covers the corrected diff.

Concur with the reviewed action guards. Automatic SIGTERM, delayed SIGKILL, and direct tmux cleanup check poll generation and current registry tracking after the last awaited proof. The new cases exercise resumed tracking during ownership verification, cleanup, and the escalation grace period.
