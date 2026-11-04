---
title: "Default-on for new multi-machine agents, step 1: a readiness report and an honest takeover line"
slug: "session-pool-default-on"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
review-convergence: "2026-11-04T06:26:17.000Z"
review-iterations: 3
review-completed-at: "2026-11-04T06:26:17.000Z"
review-report: "docs/specs/reports/session-pool-default-on-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first)"
eli16-overview: "docs/specs/session-pool-default-on.eli16.md"
---

# Default-on for new multi-machine agents, step 1

## Problem statement

Justin decided on 2026-11-03 (topic 136110) that once rebalancing is finished, conversations across
machines should be on for new agents, proven parts first. Reading the code and the 4 GB standby test
shows why changing a default cannot do this:

1. **New agents cannot climb.** `StageAdvancer.advanceTo` needs a signed green for the prior stage on
   the current build. The only producer, `SessionPoolFailoverRunner`, needs a source checkout and is
   dev-gated, so a deployed agent's stage never leaves `dark`.
2. **The first stage is not watch-only.** Any stage other than `dark` sends inbound messages through
   `SessionRouter`, which has no stage check: it places, claims and starts the conversation on the
   chosen machine. The top-level `sessionPool.dryRun` has no reader on this path.
3. **Non-development agents are missing what placement relies on.** Review of the code found:
   - a join-built standby has `messaging: []`, and a peer with no Telegram accepts a message and then
     silently returns (`DeliverMessageHandler.ts:122`, `server.ts:25836`), so the message is lost;
   - with the inbound queue off, later messages cannot be forwarded, so one conversation splits in two;
   - ownership is held in memory on these agents, so a restart forgets placements;
   - the duplicate detector is dev-gated, so "0 duplicates" would measure nothing there.
4. **Takeover does not work on a pair with no git remote.** In topic 136880's test (fb-29bc773f-713) the
   standby used `GitLeaseStore` with nowhere to push. `selectLeaseMedium` never checks for a remote, the
   commit lands locally, the push fails, and the store re-reads its own candidate: "CAS lost to epoch N
   (our candidate N)", then an immediate self-suspend. No takeover in 20 minutes. This is a defect, not a
   limit: Echo's machines run on `LocalLeaseStore` with no git lease. Pair and join gave no warning.

So turning routing on for new agents today would lose messages. This spec is step 1: it changes no
routing and writes no config. It makes the true state readable on every multi-machine agent, so step 2
is built against measured gaps and nobody is told takeover works where it does not.

## Proposed design

### Change 1: a read-only readiness report

New `src/core/poolReadiness.ts`: pure logic over injected reads, no source checkout, no model call. For
each non-revoked peer it reports these lines, each `ok`, `failing` or `unknown`, with a plain reason:

| Line | Source |
|---|---|
| contact | `liveness` direct evidence within 2 minutes |
| clock | `clockSkewStatus` |
| capacity | `MachinePoolRegistry`'s existing fresh-report rule; `loadReport.sessionsMax > 0`, `loadVerdict` not `saturated` or `impaired`, not refusing work; no fresh report is `unknown` |
| no start failure seen | peer `quotaState` present and not blocked; absent is `unknown`, and the report says this cannot prove a login |
| channels | this agent's channels are its own plus every peer's `servesChannels`; a peer on this build missing one is `failing` |
| later messages | peer advertises `ws11DeliverReceive` |
| takeover (this machine) | see Change 2 |
| ownership (this machine) | `shouldActivateDurableOwnership` on this machine's config |
| duplicate check (this machine) | duplicate reconciler `status().enabled && status().substrate.ready`, not its last tick, which runs on the lease holder only |

An agent is `ready` only when every line but `takeover` is `ok` for at least one peer; takeover belongs
to step 3. `unknown` is not ready. The last three lines read this machine only, so one machine's `ready` says nothing about its peer's store. These
lines are signals. Being ready proves nothing about a real placement, which only step 2's real test can
do, and the report says so.

`GET /session-pool/readiness` computes it on request: `{ machines, ready, peers: [...] }`. With one
machine it returns `{ machines: 1, ready: false, reason: 'single-machine' }`.

An hourly check appends one row to `logs/pool-readiness.jsonl` when there are 2 or more non-revoked
machines, so a later rung has a history to read. It rides the existing 30-second `refreshPool` beat,
so an inviter already running when it gains a peer starts logging without a restart. It writes nothing
else: no signed row, no config, no stage. It cannot affect promotion.

### Change 2: one true line about takeover

The report gains a `takeover` line. `failing` when this machine's lease store is git and it has no
remote; `unknown` otherwise, because only a real takeover proves it. The remote is read once at boot
beside the cached `leaseMedium`, never in `/health`, where a slow read makes the lifeline restart the
server. `instar pair` and `instar join` do the same local reading and, in that one case, print that
automatic takeover does not work yet on a pair with no git remote, and that adding a remote avoids it.
This is a note, not a refusal. It closes fb-29bc773f-713's request, and goes away when the defect is fixed.

### Change 3: correct the record, and awareness

The `shadow` description in `types.ts`, the "stays local" comment in `server.ts`, and the pool spec's
stage text are corrected to say what the code does. The CLAUDE.md template and migrator gain one line on
the readiness report, with the trigger "can this agent move conversations or
take over if a machine dies?". No config default changes, so no config migration.

## Steps

| Step | What it does | Must be true first |
|---|---|---|
| 1 | this spec: reports only | single-machine no-op test green |
| 2 | second spec: activation at pairing, ceiling `shadow` | every readiness line fixed for a new pair, see below |
| 3 | ceiling `live-transfer`: moves on request, takeover | a move check any agent can run; Echo's measures held; takeover fixed, see below |
| 4 | ceiling `rebalance` | the rebalancing ladder's fleet rung |

Step 2's spec starts from this list, each item found by review and read in the code:

- a peer refuses a message it cannot serve before it acknowledges it, so the router takes it back;
- a standby gets a Telegram adapter with no token, using the existing relay through the token holder;
- the inbound queue, `coherenceJournal.replication` (which also turns on the durable store) and the
  duplicate detector are set on both machines;
- moved-conversation history is fetched over signed mesh, because the join-time token differs;
- a live local session is claimed for this machine before routing, so nothing hops mid-conversation;
- activation is decided before the peer is stored, counts revoked machines, and clamps what the joiner
  receives; the `join` write uses the post-response rewrite; a repo-URL pair is not activated;
- the inviter restarts or reads activation live, so both machines agree;
- `enabled:true` is checked against the money gate (`AgentServer.ts:2383`);
- rollback is `enabled:false`, which is read live, tested with remote conversations open;
- the signed green that earns `shadow` runs only where the failover runner is dark, so there is one
  stage-0 producer and it cannot supersede a real red;
- that green expires and dies with its peer, and a lapse demotes, which needs new reconcile code;
- the test pair runs with `developmentAgent:false`, or it hides all of this.

Step 3 also needs takeover fixed on a pair with no remote. Round 3 of review, reading the code, found a
store swap is the wrong fix:

- keep `GitLeaseStore` and treat the local commit as success when there is no remote and the registry
  has a peer, read live: this keeps the epoch, boot order and `instar wakeup`, which a swap all break;
- a new holder with no live peer cannot renew, so it would serve about 60 s of every 120 s and hold
  replies; `renew` must hold when it took the lease from a peer;
- a link cut over 60 s then gives two holders, undoing "a partitioned old holder self-suspends". Add a
  rule that a machine never re-acquires its own lapsed lease unless a peer confirmed or all peers are
  presumed gone, so only the standby takes over;
- the proof is a 30-minute power-off with every reply delivered and a flat epoch, plus a link-cut test,
  on a standby that has the bot token, since a join-built one cannot answer.

## Non-goals

- Any routing, stage or config change. That is step 2.
- Already-paired agents' behaviour. They gain the report and the log row, nothing else.

## Single-machine guarantee

A test boots an agent with one machine and asserts: no log file, no
config bytes unchanged. Another test removes the last peer and asserts the check stops
writing, and a test goes one, two, one, two machines without a restart.

## Maturation plan

- **ladder:** multiMachine.sessionPool.stage

| Measure | How it proves the real state |
|---|---|
| Readiness history | `logs/pool-readiness.jsonl`, per line per peer |
| Report truth | each line is checked against its own controlled condition on the test pair, for example stop the peer and contact must fail; a failed placement alone does not blame any line |
| Placement outcome | the peer's own session result, not the router's ack, which comes first; measured separately, and includes the case where every line was `ok` and the start still failed |
| Duplicate | `logs/duplicate-reconciler.jsonl`, a separate detector |
| Lost message | inbound queue terminal failures, with the queue on |

| Rung | Who | Threshold to climb |
|---|---|---|
| practice | two test servers on a release, `developmentAgent:false`, reports only | 7 days of rows; every failing line matches a real gap read by hand |
| development | same pair at `shadow`, real channel | 20+ controlled placements; 95%+ served first time; 0 wrong lines left; 0 duplicates; 0 lost messages |
| fleet | agents pairing a first second machine | development held 14 days; same rates |

Numbers inform the review job; they do not move the feature by themselves.

## Decision points touched

None changes. The report and the printed line are signals: nothing reads them to allow or block anything.

## Rollback

Reverting the release removes a route, a log and a printed line. No state depends on them.

## Open questions

None for step 1.
