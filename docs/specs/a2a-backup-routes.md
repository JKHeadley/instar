---
title: A2A backup routes — mark the relay fall-through, fingerprint-addressed local delivery
slug: a2a-backup-routes
date: 2026-10-07
author: echo
parent-spec: a2a-honest-delivery-outcomes.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "When a direct hand-over may already have reached the receiver, the relay copy that follows is a repeat the receiver cannot recognise. Marking it, on the same thread, lets a receiver that remembers ids label it. Nothing new is sent."
binding-standards: ["Capacity Safety — No Unbounded Self-Action", "A Refusal Stays a Refusal — conservation of negative outcomes", "Ownership-Gated Side Effects"]
eli16-overview: a2a-backup-routes.eli16.md
approved: false
review-convergence: "2026-10-07T19:03:15.181Z"
review-iterations: 6
review-completed-at: "2026-10-07T19:03:15.181Z"
review-report: "docs/specs/reports/a2a-backup-routes-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — A2A backup routes

This spec makes two small changes. It adds no new re-send, no new stored
state and no new timer.

**Terms.** The *name path* is the branch of `POST /threadline/relay-send`
that hands a message straight to an agent running on this same machine, over
its loopback `POST /messages/relay-agent`, instead of using the relay. A
*fall-through* is the name path giving up on that local hand-over and sending
the message through the relay instead. A *ledger peer* is a receiver running
the inbound-id ledger (`a2a-inbound-id-ledger.md`, ACT-053), which remembers
message ids and labels a repeat as a resent copy.

## Problem

1. **The fall-through is not marked, and can land on another thread.** After
   a local POST that may have been admitted (it timed out, say), the relay leg
   reuses the same id but does not say it is a resend. It also passes the
   caller's raw `threadId`, so with no caller thread the relay copy gets a
   freshly minted thread, not the local attempt's. A ledger peer then
   delivers it as a plain new message on a different thread.
2. **A fingerprint-addressed send ignores the local route.** The name path
   matches co-located agents by name (or nickname) only. On 2026-10-06 Luna
   was addressed by fingerprint, so the local route was never tried. (Luna's
   server here was a relay standby; the relay self-heal, #2139, fixes that
   incident.)

## What exists (verified; `main` = a5f5ec3ba, `ledger` = `feat/a2a-inbound-id-ledger`)

| Fact | Code |
|---|---|
| relay-send mints `msgId` once per request; the local POST uses it; the relay leg reuses it. | ledger `src/server/routes.ts:36145`, `:36431`, `:36644` |
| The local leg uses `effectiveThreadId` (minted or resolved); the relay leg passes the caller's raw `threadId`; with none, `send` mints a new `thread-…` id. | ledger `src/server/routes.ts:36149`, `:36178`, `:36395`, `:36644`; ledger `src/threadline/client/ThreadlineClient.ts:308`, `:333-335` |
| Name path: skips nickname lookup for a hex-looking target; matches `known-agents.json` by name; two matches → 409 "Ambiguous target"; probes health (`res.ok` only); a missing token skips the POST; any non-2xx falls through; a thrown error is swallowed by a shared catch and falls through. | ledger `src/server/routes.ts:36066`, `:36272-36325`, `:36359`, `:36365-36366`, `:36431`, `:36578-36584` |
| The sender's only relay-connectivity guard (503) runs after the local branch; nothing earlier in the route checks the sender's relay or ownership state (the negotiator gate is per-thread voice, not relay state). | ledger `src/server/routes.ts:35865-36272`, `:36193`, `:36593` |
| On a failed local attempt no tracker row exists; the relay leg's verdict becomes the row's verdict. `rejected` → `failed`; a reply never acks a `failed` row. | main `src/server/routes.ts:36366-36371`, `:36490-36495`; main `src/threadline/A2ADeliveryTracker.ts:355-362`, `:443-448` |
| Honest delivery fixes "every relay refusal is `failed`" as an invariant transcription of the relay's verdict. | `docs/specs/a2a-honest-delivery-outcomes.md:272-275`, `:489`, `:496`, `:532` |
| The send chain takes an optional `messageId` and `resend`; `resend` travels inside the signed body. | ledger `src/threadline/client/ThreadlineClient.ts:314-330`, `:394-408`, `:419-427` |
| Receiver answers: 503 `{ error: 'Messaging not available' }`, 503 `{ error: 'ledger-unavailable', retryable: true }`, 401, 400, in-flight `409 { retryable: true }`, 500. | main `src/server/routes.ts:34526`, `:34539`, `:34545`, `:34828`; ledger `src/server/routes.ts:34703`, `:34716` |
| A ledger receiver adds the resent-copy notice for `resend: true` on the relay socket, and for a marked copy with no local row asks up to 8 peers (500 ms) whether one handed it off, counting failures in `peerCheckUnavailable`. | ledger `src/threadline/inboundIdLedgerWiring.ts:51`, `:66`, `:119-130`, `:250`; ledger `src/threadline/InboundIdLedger.ts:400`, `:473` |
| `/threadline/health` (unauthenticated) reports `relay.state` and `fingerprint`. A relay standby (`multiMachine.telegramPolling: false`) has no relay client, so it reports `relay.state: 'not-configured'` — the same as a relay-disabled agent. | ledger `src/threadline/ThreadlineEndpoints.ts:157`, `:253-292`, `:267`, `:275`, `:282`; ledger `src/threadline/ThreadlineBootstrap.ts:176-179`; ledger `src/commands/server.ts:18081` |
| `isCredentialShareSend`; with pairing on, the credential gate checks that an encrypted relay path exists, not which route is used. | ledger `src/server/routes.ts:35921-35922`; ledger `src/threadline/client/ThreadlineClient.ts:441-444`; `src/threadline/CredentialShareGate.ts:93` |
| `resolvePeerFingerprint(entry)` = `fingerprint`, else the first 32 chars of `publicKey`, lowercased; a fingerprint is 32 lowercase hex characters. | `src/threadline/peerFingerprint.ts:37-43`; `src/threadline/client/MessageEncryptor.ts:80-82` |
| `threadline_send` takes `agentId` as "name or fingerprint" and passes it unchanged as `targetAgent`. | ledger `src/threadline/ThreadlineMCPServer.ts:570-573`, `:646` |
| Local-route senders run at a `verified` trust default. | main `src/threadline/ThreadlineRouter.ts:1247`; ledger `:1293` |

## Threat model

`/threadline/health` is unauthenticated and self-asserted by whatever answers
on the port, and loopback ports are not bound to an OS user. The only real
binding on the local route is the per-name agent token (`verifyAgentToken`),
which any agent of the same OS user can read. The receiver runs every
local-route sender at a `verified` trust default, tracked as ACT-056 (due
2026-10-21). This spec defends against mistakes — an unlabelled repeat, a
message sent to the wrong local process or to a standby — not against a
hostile same-user process.

## Design

### 1. Mark the fall-through and keep it on the same thread (dev-gated)

A `localPostIssued` flag is declared before the name path's `try` and set
immediately before the `/messages/relay-agent` `fetch`. When it is set and
the name path falls through:

- **Same thread.** The relay leg passes `effectiveThreadId`, the thread the
  local attempt used, instead of the caller's raw `threadId`.
- **Marked unless non-admission is proven.** The relay leg passes `resend:
  true` for every outcome except this enumerated set, which stays unmarked:
  - `ECONNREFUSED` on the POST's own connection attempt (the POST `fetch` is
    wrapped in its own `try`, so an error from anywhere else in the shared
    catch never counts);
  - HTTP 400, 401 or 404;
  - HTTP 503 whose JSON body has `error: 'ledger-unavailable'`.

  Everything else after the POST is marked: a timeout, a reset, any other
  socket error, any 5xx (including the no-router 503, whose body is prose
  only), any other 4xx (including the in-flight 409), and a throw after a
  2xx. Over-marking is the safe direction: a mark on a copy that was not a
  repeat only changes the receiver's notice wording.

When `localPostIssued` is not set (no POST: a failed health probe, a missing
token), the fall-through is unmarked and keeps today's thread handling.

**The 5-minute replay rule does not apply.** The ledger spec's §5 asks a
same-id resend to wait out the relay's 5-minute replay window. A fall-through
is exempt: the relay has never seen this id, so it cannot answer
`REPLAY_DETECTED`. The relay leg is sent at once, as today.

**The in-flight 409 cannot occur here.** `msgId` is minted fresh for each
relay-send request, and the local POST in that same request is its only prior
use, so the receiver's ledger has nothing in flight under that id. If such an
answer were ever seen, the receiver holds the id, so it is marked.

**What this does not change.** After a local POST that may have admitted the
message, the relay leg's verdict becomes the row's verdict — today and after
this spec. A relay rejection then marks the row `failed` although the local
copy may have landed, and a later reply cannot ack it. This spec only adds
the label and the thread. It does not record such a row `unconfirmed`:
honest delivery fixes "every relay refusal is `failed`" as an invariant
transcription of the relay's own verdict (`a2a-honest-delivery-outcomes.md:489`,
`:532`), with no route into a different state. Changing that belongs to
honest delivery.

### 2. Fingerprint-addressed sends go local first (dev-gated)

`threadline_send` accepts a fingerprint as the address and passes it through
unchanged. Taking the local route for those sends means a sender whose own
relay connection is down or displaced still reaches a same-machine agent that
holds its relay connection: the sender's relay guard runs only after the
local branch. It does not survive a relay outage that also disconnects the
receiver, because the receiver must be connected (below).

**A separate, exclusive branch, classified first.** When the gate is on and
`targetAgent` is exactly 32 hex characters (compared lowercased), the name
path takes the fingerprint branch and never the name or nickname match. The
branch looks only at `known-agents.json` entries whose
`resolvePeerFingerprint(entry)` equals the target, de-duplicated by
`(fingerprint, port)`. Exactly one entry → local delivery as below. None, or
two distinct ports → the relay, as today (never the "Ambiguous target" 409).
A target that is not exactly 32 hex characters takes today's path unchanged.

Before the POST it reads the target's live `/threadline/health` and requires:

- **`fingerprint` present and equal to the target.** This guards against a
  stale port now held by another agent. It is not authentication.
- **`relay.state === 'connected'`.** A relay standby reports
  `not-configured` (it has no relay client), and a displaced server reports
  `displaced`; neither owns the agent's conversations, so a message there
  would cause side effects on a machine that does not own them. Health has no
  field that names a standby, so this requires the positive signal —
  connected — and also excludes relay-disabled agents. Any other state → the
  relay, unmarked.

**Credentials skip it.** When `isCredentialShareSend` is true, the branch is
not taken and the message goes to the relay's encrypted path.

Name-addressed sends are unchanged, including the `res.ok`-only probe and
today's standby behaviour.

### Logging

Each marked fall-through and each fingerprint-addressed local delivery writes
one server-log line — `[a2a-backup] id=<messageId> peer=<fingerprint>
kind=marked-fallthrough|fingerprint-local outcome=<outcome>` — and a counter
on the authed `/health`. This is the evidence for graduation.

## What it does not do

- No new re-send. The redelivery sentinel stays exactly as today, re-sending
  under a new id. Same-id re-sends from the sentinel need each relay verdict
  to name the transport attempt; that is ACT-057 (due 2026-11-17).
- No change to how the relay leg's verdict is recorded (§1).
- No cross-machine route (ACT-052).
- No refusal conservation on the name path: today it has no reachable
  explicit-refusal answer, so there is nothing to conserve yet.
- Name-addressed credential sends still go over plaintext loopback when
  verified pairing is dark; with it on, the gate checks only that an
  encrypted relay path exists. Only fingerprint-addressed credential sends
  are kept on the relay.
- No change to the `verified` default for local-route senders (ACT-056).
- No deduplication; a ledger peer labels repeats.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a fall-through is marked, and on which thread | invariant | Marked unless in the enumerated non-admission set; always `effectiveThreadId` after a POST. |
| Fingerprint branch | invariant | Exact 32-hex, exclusive, de-duplicated, live fingerprint equal, `connected`, never for credentials. |

## Multi-machine posture

- **Both changes: unified.** Each is a stateless rule applied per send on the
  machine handling it. Nothing new is stored. The fingerprint branch delivers
  only to a server that holds the agent's relay connection, so it never makes
  a standby act for the agent.
- **Ownership at fire time is the receiver's, not the sender's.** A
  `connected` relay state is a signal that this copy is the agent's serving
  machine, not proof that it owns a given conversation, and the copy can lose
  the relay between the probe and the POST. The sender does not try to prove
  conversation ownership: it has no authority over another agent's ownership
  record, and today's name-addressed local route already delivers on the same
  basis. Whatever ownership gating the receiver applies to inbound messages
  (for example duplicate-session stand-down) applies to these messages exactly
  as it does to name-addressed ones. The fingerprint branch adds no new kind
  of side effect; it only lets a fingerprint address reach the same receiver
  path a name address already reaches, under a stricter precondition.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| `resend: true` in the body | The local copy may have landed | Signed with the body; the receiver's ledger row for the id | A non-ledger receiver ignores it |
| `localPostIssued` + outcome | Whether the receiver could have admitted it | The POST's own error code or status; the structured ledger 503 | Anything else → marked |
| Live health `fingerprint` | The port belongs to the addressed agent | Self-asserted answer at POST time | Absent or different → relay |
| Live health `relay.state === 'connected'` | That server owns the agent's conversations now | Its own relay observer | Anything else → relay |

## Frontloaded Decisions

1. **After a local POST, the fall-through uses `effectiveThreadId` and is
   marked unless non-admission is proven by the enumerated set.**
2. **The fall-through is exempt from the ledger's 5-minute replay wait.**
3. **The relay leg's verdict stays the row's verdict**; honest delivery's
   invariant is not reopened here.
4. **Fingerprint addressing is an exclusive branch, classified first: exact,
   de-duplicated, never for credentials, and only to a `connected` server
   whose live fingerprint matches.**
5. **Both changes are dev-gated under `threadline.backupRoutes`**; the
   sentinel is untouched (ACT-057).

## Open questions

*(none)*

## Configuration

`threadline.backupRoutes`: `{ enabled?: boolean }`, read live. `enabled` is
omitted from defaults, so `resolveDevAgentGate` decides (live on a
development agent, dark on the fleet), with a `DEV_GATED_FEATURES` entry.

## Migration parity

- No tracker columns, state files, outbox outcomes or response fields.
- `ConfigDefaults`: none (`enabled` omitted on purpose).
- New counters beside the relay-verdict counters on the authed `/health`.
- Agent-awareness section in the CLAUDE.md template, added by
  `migrateClaudeMd()` (sniff key `A2A backup routes`).

## Rollback

`threadline.backupRoutes.enabled: false`, read live, restores today's
behaviour. A revert is safe: nothing new is stored.

## Agent awareness

Template + migrator section (`### A2A backup routes`): "When a direct send to
an agent on this machine may have reached it before I fell back to the
relay, the relay copy carries the same message id, the same thread and a
resend mark, so an agent that remembers message ids can tell it is a repeat.
A message I address by fingerprint to an agent on this machine is handed over
directly when that agent's server confirms the same fingerprint and holds its
relay connection, so it still arrives if my own relay connection is down. A
credential addressed by fingerprint still goes over the relay; one addressed
by name goes over plaintext loopback, as before. **When to use**
(PROACTIVE): a peer on this machine says it got a message twice → check
whether this feature is on and its ledger is healthy; with both, a marked
fall-through should arrive labelled, and an unlabelled copy of it is a bug to
report."

## Tests

- **Unit:** the marking set — `ECONNREFUSED` on the POST, 400, 401, 404, the
  `ledger-unavailable` 503 → unmarked; a timeout, a reset, another socket
  error, the no-router 503, any other 5xx, an unknown 4xx, the in-flight 409
  and a throw after a 2xx → marked; an `ECONNREFUSED` from outside the POST
  `fetch` does not unmark; no POST → unmarked; after a POST the relay leg's
  `threadId` equals the local attempt's `effectiveThreadId`, with and without
  a caller thread. The fingerprint branch: exact 32-hex, case-folded; a
  shorter or longer hex string → today's path; a 32-hex string that is also a
  known agent's name or a nickname → fingerprint branch only; duplicate
  entries collapsed; two ports → relay, never the ambiguity 409; credential →
  skipped; health fingerprint absent or different → relay; `relay.state`
  `not-configured`, `displaced`, `disconnected` → relay. The gate off →
  today's paths.
- **Integration:** (real RelayServer, local servers, ledger on the receiver)
  a local POST that times out falls through and the relay copy arrives on the
  same thread with the resent-copy notice; an `ECONNREFUSED` fall-through
  arrives unmarked; a stubbed in-flight 409 is marked; a fingerprint-addressed
  send to a connected co-located agent takes the local route, and to a
  standby or a stale port goes to the relay; a sender whose own relay is
  displaced still delivers a fingerprint-addressed message locally. The
  existing `tests/integration/threadline/relay-send-local-roundtrip.test.ts`
  and `tests/integration/threadline-relay-send-priority.test.ts` stay green
  unchanged (name-addressed, health mocks without a fingerprint).
- **E2E:** production bootstrap with the gate on routes a
  fingerprint-addressed send locally and logs it; with the gate off,
  behaviour is today's.

## Maturation plan

- **test-agent-live:** a throwaway agent pair on one machine, ledger on the
  receiver: one forced local timeout (marked fall-through, same thread,
  labelled) and one fingerprint-addressed local delivery, each observed.
- **dev-agent-live:** gate on for one week on the development agent. Watch
  the receiver's `peerCheckUnavailable`: a marked copy with no local row
  makes the receiver ask its peers, at a bounded cost.
- **fleet:** flip `threadline.backupRoutes.enabled` fleet-wide after the
  ledger's fleet flip, after the graduation criterion holds, and after
  ACT-056 closes — fingerprint addressing sends more traffic over the local
  route, which still runs every sender at the `verified` default.
- **graduation criterion:** judged per change from the `[a2a-backup]` lines
  and the receiver's ledger. Change 1: at least one marked fall-through that
  the receiver labelled as a resent copy, on the local attempt's thread.
  Change 2: at least one fingerprint-addressed local delivery. A zero count
  is not a pass.
- **dark-window:** at most 28 days from merge to the fleet decision. If
  either count is still zero at the end of the window, the criterion is not
  met; the reason and a new date are recorded on the tracking action — never
  left dark silently.
