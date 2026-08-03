# Reaper pool observability — Plain-English Overview

> The one-line version: asking why sessions were kept or reaped now gives an
> honest whole-pool answer instead of silently showing only the machine you
> happened to ask.

## The problem in one breath

Instar already knows how to inspect session cleanup on one machine: one read
shows the current pressure and live verdicts, another shows the history of
keep and reap decisions, and the reap-log records completed or refused
shutoffs. On an agent spread across multiple machines, asking any of the three
reads for pool scope was silently ignored. That made a local-only answer
look complete and made a dark peer indistinguishable from a peer with no reaper
activity—the wrong foundation for production verification.

## What already exists

- **Local reaper snapshot** — explains this machine's pressure and why each
  running session is being kept or considered for cleanup.
- **Local decision audit** — keeps the bounded history of changed decisions and
  reap-path events on this machine.
- **Local reap-log** — records completed and refused shutoffs, including an
  authority refusal such as `not-lease-holder`, on this machine.
- **Pool-read conventions** — other Instar reads already preserve local data,
  fetch peers without recursive fan-out, tag evidence by machine, and list peer
  failures separately.

## What this adds

All three reads now follow that established pool contract. The live read keeps
the local snapshot where existing callers expect it and adds peer snapshots in
the pool block. The audit and reap-log reads merge entries chronologically from
every answering machine and mark each entry with registry-owned machine
identity. A single-machine install
still returns an explicit empty pool block, proving that pool scope was honored.

## The safeguards

**A dark peer cannot erase the local answer.** Every registered peer contributes
either data or a classified failure. A missing address, offline registry state,
rejected address, missing route, authorization failure, timeout, oversized
response, malformed response, and unreachable peer are distinguishable from a
successful empty result.

**Fan-out is bounded and non-recursive.** Peers receive only the ordinary local
read, never another pool request. Each request has a short timeout, response-size
limit enforced while streaming, structural depth and shape validation, and the
same conservative credential-address allowlist already used by other pool
reads. The pool routes are rate-limited and send the current machine identity
required by authenticated peer reads.

**Existing callers do not change.** Without pool scope, all three reads retain their
prior response shapes. The new logic is read-only: it cannot keep, kill, restart,
move, or otherwise alter a session, and it writes no durable state.

## What ships when

The three reads, tests, agent-facing instructions, and public documentation ship
together in one patch. There is no migration or activation flag because the
change only makes an explicitly requested read honest; rollback is a code
revert and leaves no state behind.

## What you actually need to decide

Does this established pool-read shape satisfy the requirement that reaper
verification cover every registered machine without letting one dark peer hide
the local evidence or masquerade as an empty result?
