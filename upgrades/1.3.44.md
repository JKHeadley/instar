# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Cross-machine seamlessness — full wiring landed (mostly dark).** The integration
follow-on to PR #419. #419 shipped the seamlessness *components* (G1 fenced lease,
G2 auto-sync, G3 ledger/outbox/live-tail/HandoffSentinel logic) unit-tested but
not wired into the live path. PR #428 wires them in — the machine-to-machine
"phone line", the handoff conductor, and the exactly-once message guarantee — and
proves each end-to-end. Single-machine agents are completely unaffected: every new
component is gated on a multi-machine mesh + lease holder + (where flagged) an
explicit opt-in config flag.

What's now LIVE on every install (not flag-gated, but no-op on a solo agent):

- **Lease wire transport** — `HttpLeaseTransport` + `POST /api/lease` route, into
  `LeaseCoordinator`. Single-machine no-op (no peers).
- **Live-tail streaming** — holder pushes the encrypted conversation tail to the
  standby on a cadence (`LiveTailSource` → `HttpLiveTailTransport` → receiver
  `LiveTailBuffer`); redaction-before-encryption; only the lease holder streams.
- **Handoff conductor** — `HandoffSentinel` (outgoing) + `HandoffReceiver`
  (incoming) bolted into server boot; `POST /api/handoff/{begin,ack,yield}`
  (signed) + `POST /handoff/initiate` (operator trigger). The lease is **never
  yielded** unless the incoming machine's echo verifies AND validation passes —
  proven over two real booted servers (caught-up → handed-off; divergent → aborts
  and stays awake = no two-captains).

What's DARK (behind `multiMachine.exactlyOnceIngress`, off by default until a live
two-machine test-as-self confirms no false-drops on the most critical path):

- **Exactly-once ingress ledger** — `MessageProcessingLedger` for inbound dedup +
  outbound `FencedOutbox` for reply commit, plus `ReplyMarkerTransport` propagating
  the `reply_committed` marker to standby peers so a post-handoff redelivery can't
  re-send a reply the old holder already committed.

Architecture documentation added: `site/src/content/docs/features/multi-machine.md`
gains a "Seamlessness Architecture (Components)" section grouping the 14 new classes
by role (coordination, planned handoff, live-tail streaming, exactly-once delivery,
update coordination).

## What to Tell Your User

- The seamlessness wiring you've been hearing about is now landed — your laptop and a
  second machine (when you have one) can take turns being the awake agent without
  losing the conversation. On a solo setup nothing changes; this is groundwork.
- The trickiest part — making sure a reply never goes out twice during a hand-off —
  is wired but turned off by default until I've live-tested it on two real machines.
- A new architecture doc page explains the components in plain English if you ever
  want a tour: Multi-Machine → Seamlessness Architecture.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `POST /api/lease` | Low-latency lease transport between mesh peers (server-to-server, signed). Solo agents see no traffic. |
| `POST /api/handoff/{begin,ack,yield}` | Planned-handoff protocol endpoints (signed, machine-to-machine). |
| `POST /handoff/initiate` | Operator trigger: gracefully hand the awake role to a specific peer. |
| `multiMachine.exactlyOnceIngress` (config flag, default off) | Enables the inbound-dedup + reply-commit guarantee. Flip on only after a two-machine live test confirms no false-drops. |
| Multi-Machine doc: Seamlessness Architecture | New section in `site/src/content/docs/features/multi-machine.md` — names each component, groups by role. |

## Evidence

**Integration follow-on, mostly wiring + boot glue.** All component logic was
unit-tested in #419; this PR adds the live-path wiring with paired wiring-integrity
tests for each bolt-in. Two real booted servers exercised the handoff protocol
(caught-up → handed-off; divergent → aborts and stays awake). Single-conflict merge
of main into the branch (only `src/commands/server.ts`, in the AgentServer
constructor call — both sides added new components; resolution kept all and merged
the field list). `tsc --noEmit` clean post-merge. Docs-coverage class floor cleared
(54% → 56%, > 55% floor).
