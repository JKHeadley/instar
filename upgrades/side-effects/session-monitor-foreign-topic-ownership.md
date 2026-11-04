# Side-Effects Review — foreign-topic session notices

**Version / slug:** `session-monitor-foreign-topic-ownership`
**Date:** `2026-11-04`
**Author:** `Echo`
**Tier:** 1 — narrow reversible bug fix; seven files, one review round, no commit attempts yet.
**Second-pass reviewer:** GPT-6 Astra (independent subagent)

## Summary of the change

`src/commands/server.ts` now gives `SessionMonitor` the ownership record's answer instead of making foreign ownership conditional on pool stage, record activity, and peer reachability. `src/monitoring/SessionMonitor.ts` rechecks ownership after asynchronous recovery and triage. Two unit test files cover the decision and handoff race. The decision point is whether this machine may diagnose and announce a topic's session state. The conversation reply route is untouched.

## Decision-point inventory

- `SessionMonitor` topic filter: modified to use recorded ownership for a foreign topic.
- `SessionMonitor` post-recovery and post-triage checks: added to prevent a stale poll decision from becoming a notice after a handoff.

## 1. Over-block

A foreign topic whose peer is offline will not receive a stopped-session notice from this machine until ownership transfers. That is intentional: the peer's availability does not grant this machine authority to describe the session. A topic with no record, a released record, or a local owner is still monitored.

## 2. Under-block

If the ownership registry is absent or throws, the monitor retains its old behavior; the existing late initialization path requires this. A record that is itself stale could make the monitor silent until reconciliation updates it. The direct conversation reply path stays open, so silence here does not block an owner reply.

## 3. Level-of-abstraction fit

The ownership registry is the authority for which machine owns a topic. Peer liveness is a signal for failover, not permission for a non-owner to announce a session death. The monitor consumes the existing record; it does not create a competing ownership system.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). This is a structural ownership invariant, not a judgment about message content. The record's current owner determines who may report local session state. The change removes peer liveness from that authorization decision. It adds no text filter or general outbound block.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The ownership record is the deterministic authority; availability remains in failover decisions elsewhere.

## 5. Interactions

The monitor still skips foreign topics before recovery and triage. It now rechecks after awaits where a handoff could happen. Existing ownership reconciliation and failover transfer the record; this code does not transfer it. It neither closes `/telegram/reply` nor changes the normal conversation dispatch path. A genuine local death still reaches the existing once-per-death ledger and notification flow.

## 6. External surfaces

Telegram users will stop seeing the false notice from a non-owner. The monitor's own recovery/triage for a foreign topic is skipped. No route, message schema, persistent state, dashboard, or operator action changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Replicated via the existing topic ownership record and its pool replication path. Each machine reads its local materialization of that record. User-facing notices require one voice: the recorded owner may report its local session; other machines do not. The existing dead-notice ledger remains machine-local, and this change creates no durable state or URLs.

## 8. Rollback cost

Revert the code and ship a patch. No migration or agent state repair. During rollback, a non-owner with a stale mapping could again send the false notice when its peer appears offline.

## Conclusion

The narrow change aligns the monitor with topic ownership and closes the handoff gap without affecting conversation replies. Tests reproduce the race before and pass after; targeted monitor tests and type checking pass. Clear to ship after independent review and required gates.

## Second-pass review

**Reviewer:** GPT-6 Astra (independent subagent)
**Independent read of the artifact:** concur

The ownership FSM confirms `ownerMachineId` remains the draining source during transfer and `released` has no owner. The monitor checks the ownership record before diagnosis and again after the asynchronous steps preceding the stopped-session send. Peer reachability no longer grants authority, and `/telegram/reply` is untouched. The reviewer found no blocking concern; the absent or unreadable registry still fails open, as documented above.

## Evidence pointers

- Bug topic 10000001574 and Telegram topic 135786 history.
- Mac Studio record: `.instar/ownership/local/135786.json`, assigned to Mama PC at 2026-11-04 02:35 UTC before all three false notices.
- Targeted unit run: 53 passed; TypeScript `--noEmit` passed.
