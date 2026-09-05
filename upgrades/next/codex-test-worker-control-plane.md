# Codex Test-Worker and Inbound-Delivery Reliability

<!-- bump: patch -->

## What Changed

The session watchdog now recognizes Vitest's long-lived esbuild service as
framework infrastructure and excludes it before stuck-command judgment. If a
genuine descendant process must be stopped, the watchdog revalidates the exact
process identity and session incarnation immediately before signaling that
process, then escalates through bounded targeted signals instead of sending a
pane-wide interrupt that can collapse the surrounding Codex turn.

Codex session discovery now uses the maintained state cache on asynchronous
control-plane paths, and quiet Codex panes are not synchronously probed unless
there is evidence of a stranded draft. This keeps test execution from starving
health and Telegram handling. Recovery notices also state their actual queue
reason so operators can distinguish a queued continuation from a delivered
one.

Inbound deliveries whose physical effect cannot be proven after bounded
observation now enter an explicit terminal effect-unknown state. They remain
auditable without occupying live-capacity slots forever, preventing an
ambiguous historical backlog from blocking new Telegram messages.

The release canary also found a second observer defect under real load: when a
busy Codex transcript grew by more than one read budget, a read ending partway
through the next JSONL record discarded the valid complete prefix as unknown.
The observer now durably advances through the last complete record and re-reads
the partial tail on its next bounded sweep. Truly oversized single records,
malformed JSON, schema drift, and identity mismatches still fail closed.

## What to Tell Your User

Long-running Codex test work is protected from false watchdog interruptions,
and the agent's health and messaging paths remain responsive while those tests
run. Ambiguous old deliveries remain visible for investigation but no longer
crowd new messages out of the live queue.

## Summary of New Capabilities

- Automatic protection for the exact Vitest esbuild service process.
- Process-targeted watchdog remediation with action-time identity checks.
- Responsive cached session discovery on asynchronous control-plane paths.
- An explicit terminal state for deliveries whose physical effect is unknown.
- Multi-pass observation of valid busy-session transcript backlogs without
  false unknown outcomes at non-aligned byte boundaries.
- Clear queue-reason wording in Codex recovery notices.

## Evidence

On topic 67366, the watchdog audit and live process tree showed the watchdog
selecting Vitest's persistent esbuild service and then issuing a pane-wide
interrupt; the surrounding test run collapsed while the local health endpoint
also stopped responding and Telegram retried the inbound message. The repaired
candidate's focused unit, HTTP integration, and production-lifecycle E2E gates
all pass, including a real long-running Vitest worker whose esbuild service
survives unchanged while the lifecycle suite completes. A backed-up copy of the
live inbound ledger contained 496 ambiguous rows consuming capacity; applying
the new terminal transition reduced the live count to four while retaining the
rows for audit, and normal inbound dispatch resumed.

The first exact-candidate two-hour/50-delivery canary correctly refused to sign
after finding three false unknowns on unrelated busy sessions. Their transcript
records proved the messages and responses existed beyond a non-aligned 256 KiB
scan boundary. The corrected scanner has unit, integration, and production-wired
E2E coverage for that exact multi-budget shape. The fresh corrected candidate
then passed 50/50 deliveries over 7,213,141 ms, all required special cases,
30/30 responsiveness samples, and zero false-unknown, exhaustion, duplicate
ownership, lost-input, or stale-owner outcomes. Echo signed the resulting
evidence and the certified source manifest binds its exact digest and bytes.
