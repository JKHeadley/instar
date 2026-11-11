---
title: "A standby without the Telegram login keeps a reply when the sending machine is unreachable"
slug: "standby-durable-forward-without-token"
eli16-overview: standby-durable-forward-without-token.eli16.md
author: echo
created: 2026-11-11
status: draft
origin: "Justin, 2026-11-11, topic 141014 (24-hour run: fix the stuck M5-to-Studio message route)"
parent-principle: "No silent degradation; Verify the State, Not Its Symbol (P20); a late reply costs less than one that never arrives (QueuedReplySupersession); Signal vs Authority"
---

# A standby without the Telegram login keeps a reply when the sending machine is unreachable

## Problem

An agent on several machines sends Telegram messages from one machine only: the lease holder, which holds the bot credential. A standby without a bot token of its own hands each reply to the holder. The M5 is one: `messaging[telegram].config.token` is `""`, and there is no secret-store token.

`telegram.outboundRelay` (`src/commands/server.ts` ~32719) has two hand-off paths:

1. **Durable forward** (`forwardReplyToHolder`). It settles the lease route, prepares an operation, and submits it. If that fails, it admits the reply locally as `held` with a retry ladder, and the recovery tick (`runtime.options.forwardRecovery`) re-forwards the same operation id. This path and all its wiring (recovery, `onHeldForwardExpired`, `onLeaseHoldObserved`, `holderForwardPolicy`; ~32631) are gated on `hasUsableBotToken && meshSelfId`. The token is used only to derive the bot account id (`String(originBotToken).split(':')[0]`, ~32594).
2. **Direct relay** (`relayOriginBot`, `OriginMeshRelay.ts`). Every token-less standby uses this path. It first asks the holder for `capabilities`. If that request fails, it throws `TelegramOriginHoldError('origin-peer-unreachable')` **before preparing or recording anything** (`OriginMeshRelay.ts:27`).

The route answers `409 telegram-origin-held` with no operation id. `telegram-reply.sh` (its `*)` branch, ~line 687) then prints "MAY ALREADY BE DELIVERED… Do NOT resend". But the server knows that nothing reached Telegram and that nothing is held. The message reports the symbol "held" while the state is "dropped". The reply is lost.

**Observed twice on 2026-11-11.** At 05:04Z, a topic 141469 status reply went out while the Studio had stopped responding. It was never delivered, and a manual catch-up was needed. Around 20:23Z, the topic 141014 root-cause explanation went out while the Studio's `/health` refused connections. It was missing from pooled history once the Studio was back, and was resent by hand. The M5's origin store has never had a single `telegram_origin_operations` row.

## What already exists (verified against main, v1.3.1739)

- **The durable forward path:** the ladder, re-forward, held notice, expiry item and receipt reconciliation (`OriginForwardToHolder.ts`). Receipt reconciliation runs when the last attempt was `outcome-unknown`, before any other dispatch decision.
- **`UNRESOLVED_LEASE_HOLDER`:** a placeholder execution owner used to seal a hold when no holder is settled. Recovery later **supersedes** it with an operation for the real holder (`recoverForwardedHold`, the "holder changed" branch). The new row is made durable first and the old one retired in one store transaction, so exactly one durable row carries the reply at every instant.
- **A token-less boot's placeholder account.** A token-less boot already uses the placeholder account `'unresolved-tokenless-source'` for its runtime and notice destination (`TelegramOriginBoot.ts` ~177, ~191, ~235). This spec reuses that exact string as `UNRESOLVED_TOKENLESS_ACCOUNT` and adds no second placeholder.
- **The holder's `capabilities` answer** carries `accountId` and `executionOwnerMachineId` (`OriginMesh.ts` ~76). A holder without a token answers `accountId: null`. `capabilities` replies only after the recipient-bound mesh envelope and `resolveKey(authenticatedSender)` pass.
- **The holder's submit handler** refuses a sealed account that is not its own with `origin-plan-invalid` (`OriginMesh.ts:136`). This happens **before** `putVerifiedEvidence` and admit, so it is a definite, custody-free refusal.
- **The recovery tick** has no token gate (`TelegramOriginRuntime.ts` ~412, ~568). Runtime token checks cover legacy import (~724), capacity `accountIds` (~152) and the recording-healthy notice (~294). None of these touch admit, hold or the ladder.
- **A token-less adapter cannot make a local send.** `TelegramAdapter` routes every send through `outboundRelay` when it has no token (~898, ~912). So a token-less machine never creates direct-path (`onLeaseHoldObserved`) holds of its own.
- **`confirmedRecoveredForward`** (`OriginForwardToHolder.ts` ~24) follows only ONE `supersededBy` hop.
- **The held-reply review** (`allowQueuedRecovery` → `reviewQueuedReply`) runs before each re-forward and retires a held reply that a newer agent message overtook. That rule is narrowed by PR #3082, which records the retirement as `overtaken-reply`. The review answers `hold` whenever the pool history read fails, so during a holder outage a held reply waits rather than being judged.

## Proposed change

**Prerequisite:** PR #3082 (a user message alone never retires a held reply; retirement is recorded as `overtaken-reply`) merges first. Every statement below about the overtaken review assumes its behavior.

### 1. Read the holder first, then seal

On a token-less machine, every attempt runs in this order: **read `capabilities` → prepare → (supersede) → submit**. The attempt is a request-time forward or a recovery pass, and each runs exactly one capabilities read.

- `submitOriginToHolder` gains an optional `capabilities` input: a validated answer already read in this attempt. When it is given, the function skips its own read.
- `ForwardDeps.prepare(holder, input, { operationId?, accountId })` takes the account explicitly. It keeps the existing optional `operationId`, which §2 uses for derived successor ids. The token-less read lives in `forwardReplyToHolder` and `recoverForwardedHold`. The direct relay (`relayOriginBot`) passes the answer it already read into `submitOriginToHolder`, so it does not read twice either.
- An answer is valid when it arrives through the authenticated mesh client (the recipient-bound envelope and `resolveKey(authenticatedSender)`), from the settled holder, with `credentialOwner: true` and an `accountId` matching `/^\d+$/`. Any other answer, including a null or non-numeric `accountId`, is treated as unreachable.
- **Holder reachable:** the reply is sealed directly with the live account. It is submitted once, with no placeholder, no re-seal and no orphan record. This is the normal path for every reply on a healthy pool.
- **Holder unreachable:** the read fails and nothing is submitted. The reply is sealed with `UNRESOLVED_TOKENLESS_ACCOUNT` and held at once. Its owner is the settled holder if the lease settled to a named peer, otherwise `UNRESOLVED_LEASE_HOLDER`.

Worst case per attempt is the same as today, about 60 s inside the reply route's 120 s budget: settle (≤15 s), one capabilities read (≤15 s), one submit (≤15 s) and the notice (≤15 s). The send-policy review runs once per prepare, as today. `FORWARD_ATTEMPT_BUDGET_MS` is declared but not enforced today, and that stays unchanged.

### 2. Re-sealing: placeholder only, and only in recovery

`recoverForwardedHold` reads `capabilities` once per pass (see §3 for the per-holder short-circuit). The re-seal and account checks run only after the existing custody checks: `outcome-unknown` receipt reconciliation, then settling, then `local-sent`. The new and changed branches:

- **Placeholder seal, holder answers.** Supersede to an operation sealed with the live account, using the existing single-transaction `deps.supersede`. The new operation keeps the same content, `authoredPreparedAt`, detail and ladder state, and gets an explicit, deterministic `operationId` derived as `<root>~r<hop>-<plan8>`. Here root is the chain's first operation, hop is the chain position counted across every supersede kind (placeholder re-seal and holder change alike), and plan8 is the first 8 hex characters of a digest over stable fields only: `contentDigest`, the sealed `accountId`, the execution owner, the canonical destination and the number of children. It deliberately excludes `planDigest` and every child `requestDigest`. Child and materialization ids are fresh `randomUUID()` values on every prepare, and a companion (footer) child's request embeds its parent's random `childId` as `companionOf` (`OriginBotPlanner.ts` ~95-111), so none of those is stable across prepares. This keeps the id flat and well under the 256-character id limit. That id consumes no logical-send ordinal. It stays unique per hop and per plan, so an A→B→A flap cannot collide, and a crash between `prepare` and `supersede` followed by a retry against a different holder or account produces a different id. Only the supersede transaction makes a successor durable. An identical retry reuses the same id, so it cannot mint two successors. A crash between prepare and supersede leaves only an intent record, which can never be dispatched, because nothing admits it. That record is audited as `reseal-orphan-intent`. Superseding rows inherit the original row's deadline. It is submitted in the same pass, with that same `capabilities`. The superseding seal is asserted never to be the placeholder. If the holder also changed, both owner and account are resolved in this one supersede.
- **Holder changed, concrete seal.** The existing "holder changed" supersede now passes the row's **sealed** concrete account to `prepare`, and uses the same id scheme. It never passes the placeholder, so a holder move can never launder a concrete seal into a placeholder.
- **Concrete seal ≠ live account (`account-changed`).** This means the holder's bot is not the one this reply was sealed for. The row is **never re-sealed automatically** and nothing is sent, because a misconfigured or swapped holder must not be able to re-send held content under another bot. The row is retained. ONE attention item per (sealed account, live account) pair lists the affected topics: "Held replies sealed for bot <sealed> are waiting: the sending machine now uses bot <live>". Each new row adds its topic to that same item (P17). No re-seal action is offered in this change. Absent one, the rows expire at the 6 h deadline, which raises the existing expiry item. The attention item says this plainly: "These replies will expire at <time> unless the original bot returns."
- **Accounts match and the holder refuses with `origin-plan-invalid`.** Today's handling is unchanged: the row is recorded `refused` and re-attempted on later eligible ticks.

### 3. Held replies from one outage never retire each other

The overtaken review (`reviewQueuedReply`, #3082) asks whether a newer agent message reached the topic. Recovered session replies are recorded with provenance `agent`, and the holder records its own history row for each message it sends.

**The authoring machine stamps held deliveries.** The holder writes no topic-history row for a mesh `submit`, because it sends with a direct `telegramFetch`. The row for a forwarded reply is written by the standby: `recordRecoveredOutbound` for a recovery delivery, and the adapter's send log for a request-time delivery.

The standby adds `forwardedHeld: true` to that row exactly when the operation was persisted in phase `held` before the submit that delivered it. `forwardContext.heldMs` uses the same definition: 0 unless the row was persisted `held` before this submit, and otherwise measured from that persisted moment, never from `authoredPreparedAt`. It is telemetry only. The holder never acts on it, and the stamp is decided on the standby from its own persisted state. A live forward whose first submit came back `outcome-unknown` and was resolved in the same request was never persisted `held`, so it is not stamped.

Pooled history reads (`scope=pool`) merge every machine's rows and pass the field through, so every held reply in the pool sees the same answer, whichever machine authored, recovered or reads it. `queuedReplyOvertaken` ignores rows with `forwardedHeld: true`, so only live agent messages overtake a held reply.

When a submit's response is lost, the standby writes no history row until the receipt resolves. Nothing appears in history that could overtake anything, which is safe. `recordRecoveredOutbound(topicId, text, messageId, provenance, { forwardedHeld, acceptedAt })` gains an options argument, and `confirmedRecoveredForward` returns the standby-clock `acceptedAt` it observed when the receipt resolved. A peer's `forwardedHeld` value is taken as given within the pool's trust boundary: a paired machine could mark live replies as held, which is the same trust as everything else a paired machine reports. The overtake comparison uses the row's `timestamp`. On both the recovery and request-time paths, the standby sets it from its own clock when it resolves the accepted receipt. The receipt carries no holder `acceptedAt` field and the wire is unchanged, so for a row the same standby authored, `preparedAt` and the timestamp share one clock.

**Cross-machine rows** are a row from another machine overtaking this machine's held reply. They use the existing skew tolerance `OUT_OF_ORDER_CLOCK_SKEW_MS` (`OriginStoreBackend`). Such a row overtakes only when its timestamp is later than `preparedAt + OUT_OF_ORDER_CLOCK_SKEW_MS`. Within the tolerance it does not overtake, and the held reply is delivered. That direction is chosen because a possible late duplicate is preferred to a possible loss, consistent with §3's named risk.

Rows from older standbys carry no stamp, so they count as live: today's #3082 rule, listed in the mixed-version table. An old peer can never strip a new standby's stamp. In the pooled read (`scope=pool`), each peer answers with only its own local rows (`includeOrigin=1`), and the reading machine merges them. So a stamped row is always served by the new standby that wrote it.

**Named risk.** While A is held, the agent is told "HELD — not delivered yet". If it then writes a correction C, and C is also held, both are delivered, possibly C first. The user may then see the stale answer after its correction. Each carries the existing late-arrival and out-of-order labels (`lateRecoveredReplyNotice`). This is accepted. A possible duplicate is strictly better than a silently lost answer, and the agent can see both deliveries in topic history.

Delivery order is therefore irrelevant to retirement. The recovery ladder needs no head-of-line blocking and no pull-forward, and each row keeps its own backoff. As a cheap preference, due rows are processed oldest `authoredPreparedAt` first within a tick.

Each tick begins with ONE shared reachability check: the `capabilities` read to the settled holder, which also flushes `forwardContext.events`. That runs before any per-row review, and before receipt reconciliation for rows whose last attempt was not `outcome-unknown`. If it answers `unreachable`, every row for that holder skips both the RPC and the pool-history review read. The same check also runs on ticks with no held rows while open `not-sent` posts or unacknowledged events remain, so recovery-triggered re-posts and evidence flushes do not depend on a held row existing. They are retained **without** advancing their ladder state, because no attempt was made. A blackholed holder therefore costs one network timeout per tick, not one per row.

### 4. A token-less machine never "sends locally"

- **In `recoverForwardedHold`.** When `route.kind === 'self'` and `deps.canSendLocal()` is false, the row is retained **without** the `local-sent` marker and treated exactly like `settling` (`retained-self-no-transport`). `canSendLocal()` is a new dep that is true iff the machine has a usable bot token. When the lease moves to a credentialed machine, the next tick re-forwards.
- **In `forwardReplyToHolder`.** A `self` settle on a token-less machine does not return `{ kind: 'local' }`. It goes straight to the durable hold, with owner `UNRESOLVED_LEASE_HOLDER` and `lastAttempt: 'unsettled'`.

### 5. Wiring: always drain, create holds only when the gate is live

- **Recovery and expiry are always wired.** `forwardRecovery`, `onHeldForwardExpired` and `holderForwardPolicy` are wired whenever `telegramOriginBoot && meshSelfId`, with or without a token and regardless of the gate. A machine that was ever live under the gate still drains its held rows after the gate goes dark.
- **The gate controls only the creation of holds.** On a token-less machine, the outbound branch (~32722) takes the durable forward only when `meshSelfId && forwardSwitchOn() && tokenlessDurableForwardOn()`. Otherwise it uses the direct relay, which reports honestly per §6.

### 6. "Not held" is never reported as "held"

When `relayOriginBot` fails before preparing anything, it throws `TelegramOriginHoldError(reason, undefined, 'not-sent')`, and the route's 409 body carries `outcome: 'not-sent'`. That covers `origin-peer-unreachable`, `origin-peer-protocol-unavailable` and `execution-owner-mismatch` at the capabilities step. Other id-less errors (for example `logical-send-content-conflict`) keep their current outcome, because they describe a different state.

`telegram-reply.sh` maps `not-sent` to its existing `not-delivered` text ("NOT SENT — this message never reached Telegram… It is safe to send it again.", exit 1), without the operation-outcome lookup. This is always on, because it only corrects a false message. The script is the scaffold template `src/templates/scripts/telegram-reply.sh`, and its new hash is registered for `migrateScripts`.

### 7. Supersede chains are followed to the end

`confirmedRecoveredForward` and the lookup behind `/telegram/origins/operations/:id/outcome` both follow `supersededBy` links until they reach a row with no successor. A visited set stops the walk on a cycle. A successor id whose row is missing (for example, pruned by retention) resolves to `unknown`, never to the last row found.

For the outcome endpoint this is new code: today it follows no links at all (`telegramOriginRoutes.ts` ~175). Its remote-owner downgrade uses the **terminal** row's owner, because the original row's owner may be the `UNRESOLVED_LEASE_HOLDER` placeholder.

A chain grows only by a supersede, and supersedes are bounded by the ladder and the row's deadline, so the walk needs no numeric cap. The operation id the route first returned therefore reports `delivered` even after a re-seal and a holder move.

### 8. Where a token-less machine's notices go

**Notice-class sends are never held.** Notice-class means the explicit producer ids `reply-delivery-notice` (existing) and three new ids this change assigns to the sends that today run unbound: `held-forward-notice` (the holder-routed delay notice), `attention-hub-post` and `held-expiry-report`. On a token-less machine with an unreachable holder, they are not turned into durable holds. The item itself is recorded in the local attention store, so it is visible on that machine's dashboard and in the pooled attention read. Its hub post is recorded `not-sent` in the audit. This means:

- no stale "my reply is delayed" message is delivered after the reply it describes;
- no expiry item can re-raise itself;
- the "zero held rows" rollback check is never blocked by notices;
- while the holder is unreachable, the item stays visible on the local dashboard and through the pooled attention read, which includes expiry items;
- `notice-not-held` items are collapsed per topic per outage through the existing `heldCollapser`;
- **re-posting when the holder returns.** When the recovery tick next gets a valid `capabilities` answer, the standby re-posts the hub post of each attention item that is still open and was recorded `not-sent`. It is an ordinary live send, not a held operation, under the logical-send key `attention-repost:<itemId>`, in a fresh logical-send scope at ordinal 0. The operation id (`originDigest({ key, ordinal })`) is therefore identical on every retry, and the holder's dedupe stops a second copy after a crash or a lost response. The item is marked re-posted only after an accepted receipt. A re-post that answers `not-sent` again leaves the item eligible for the next answer. This covers the expiry report as well, so an outage that ends in expiry still reaches the hub.

The local held attention item that the forward path already raises when a hold is created (`raiseHeldItem`) is also what re-surfaces the custody line after the first response.

The classification uses those producer ids, not `producerKind`. Other `server-automation` content that users read (job results, status lines) is held and delivered like a reply. There is a test.

### 9. Custody is said out loud

The route's held response for a token-less hold adds `custody: 'this-machine-only'`. When it sees that field, `telegram-reply.sh` adds one line to its existing pending text: "Kept on this machine only until the sending machine is reachable; if this machine goes down first, the reply is lost."

That case is a named debt: a standby lost during an outage takes its held rows with it.

**Where the debt is recorded.**

- **On the standby.** The held row lives on disk, so a reboot is fine: the row recovers.
- **On every pool peer the standby can still reach.** When it creates a token-less hold, the standby sends the operation's metadata-only evidence through the existing mesh `evidence` action, once per peer. That is the envelope only: destination, content digest, authored time and origin machine, never the text. Peers come from the same resolver the pool reads use (at most 8 online peers, best effort, about 1.25 s each). It runs in the background after the route has answered, so it adds no route latency.
- **On the peers' status read.** Each peer's `GET /telegram/origins/status` gains `peerHeldDebt`. It lists evidence records from other machines that have no accepted receipt and are older than the hold deadline, and shows them as "pending on <machine>, outcome unknown". Its dashboard shows the same list.
- **Clearing a debt entry.** An entry stays open until the origin machine comes back. Nothing certifies it away and nothing ages it out. When the origin machine next contacts a peer, it reports each listed operation's outcome (`delivered`, `retired`, `expired` or `outcome-unknown`) in a command-level `forwardContext.outcomes: [{ rootId, outcome }]` on a mesh `capabilities` read to every peer it sent evidence to. A peer closes an entry only when the authenticated sender is that entry's origin machine. Old peers ignore the field, and their entries stay open. An `outcome-unknown` entry (a hold that ended through `settleUnknown`) closes as "may or may not have been delivered", which is shown distinctly from a loss. Each outcome is (`delivered`, `retired`, `expired`), keyed by the root id and resolved through the §7 chain walk to the terminal row. Only then is the entry closed. The origin keeps each root's outcome until every listed peer has acknowledged it, so a pruned terminal row can never leave an entry stuck at `unknown`. The one other closure path is at the machine level. When the owner, from their phone, records the origin machine as **gone** in the owner-signed team records, every open entry for that machine is recorded as a real loss and closed. That record is the existing gone-machine entry in `TeamAccessLog` (~771), which today only retires the machine's team-access streams. This change adds the debt closure as a second consumer of the same signed record, so no new owner action and no new authority is created. Nothing ages an entry out. Entries are filtered to token-less hold evidence (`tokenless: true`, in the evidence's command-level context) and listed per origin machine, collapsed as a count plus the oldest authored time. The list is shown collapsed per origin machine (count and oldest authored time), so it cannot flood the surface.

**What is not covered.** Permanent loss of the standby during a partition that also cuts it off from every peer. Then no surviving machine can be told, because that is what such a partition is. Today the same reply is lost with no record anywhere, so the change is strictly better. That residual is accepted as a named risk and reported in the release fragment.

The debt itself is accepted. Copying unsent reply bodies to more machines would widen where conversation content lives, and the exposure window is no longer than the outage.

### 10. Observability and maturation

**Local audit (standby).** The existing held-forward audit, `.instar/logs/telegram-origin-held.jsonl`, gains these outcomes:

- `account-reseal`
- `account-changed`
- `retained-self-no-transport`
- `retained-holder-unreachable-tick`
- `notice-not-held` (a notice-class send that found the holder unreachable)
- `not-sent`, logged from the route

Every row carries `tokenless: true` when the authoring machine has no token, and `gateLive: true|false`. The `heldForward` summary on `GET /telegram/origins/status` gains counts of token-less holds by phase.

**Evidence where the review runs (holder).** The maturation review reads only local logs, and runs only on the lease holder (`MaturationLadderService.ts` ~387, ~577). So the standby carries its evidence to the holder in a command-level `forwardContext`:

```
forwardContext: {
  tokenless: true,
  resealed: boolean,
  heldMs: number,
  events: [{ id, kind: 'expired-undelivered' | 'not-sent-while-live', at }]
}
```

`forwardContext` rides on every mesh `capabilities` read and every `submit`. It sits outside the signed record, so the envelope and digests are unchanged, and older holders ignore it. The `events` list carries the standby's audit events that have not yet been acknowledged. Each event id is fixed when its audit row is written, not minted per send. The list is capped at 50 events and 16 KB per command; anything over the cap waits for the next command, and the holder drops excess rather than refusing the command. The holder answers with `evidenceAck: [ids]`, and the standby stops resending those ids. The recovery tick reads capabilities every pass, so events reach the holder even when nothing is delivered.

The holder writes to its `logs/feature-evidence.jsonl` with `featureId: 'telegram.tokenlessDurableForward'`:

- one `kind: 'fired'` row per accepted submit that carries `forwardContext`, including `context.resealed` and `context.originMachineId`;
- one `kind: 'error'` row per event. Events are recorded at most once per `(authenticatedSender, id)`, through a seen-id file next to the log with the same retention as the evidence window. The file is per holder; after a lease move, events not yet acked are recorded once on the new holder.
- `fired` rows are deduped by `operationId`.

`forwardContext` is a signal only. It never changes how the holder handles the command. Its contents are self-reported by the agent's own machines: on `submit`, any machine that passes `resolveKey`; on `capabilities` too, because `resolveKey(authenticatedSender)` runs before every action. On the holder, a `capabilities` read that carries events becomes a write (the seen-id file and the evidence log). A machine could under-report harm, so acceptance 8 (pooled history, matched to the holder receipt) and the arbiter's review are the guard against a misleading graduation, not the counts alone.

**Ladder entry.** `src/data/feature-ladders.json` gains a ladder entry:

- `id: telegram.tokenlessDurableForward`, flag `messaging.tokenlessDurableForward.enabled`, disposition `ladder`, final `default-on`, risk `standard`.
- Its `dev-agent-live` rung uses `advance: { kind: 'code' }`, `soakDays: 7` and `windowDays: 14`, the `usage.ledger` precedent.
- **ran:** `fired` rows with `context.resealed: true`, `count` at-least 1, `minSamples: 1`.
- **harm:** `error` rows `of` all rows for the feature, `ratio` at-most 0.

Both metrics use the standard reducers, and the window keeps one old event from failing the rung forever. Duplicate sends are not a ladder metric, because no log can observe a duplicate Telegram delivery. They are proven by acceptance 3–6 (exact counts) and 8 (holder-side history).

A token-less machine that never contacts the holder sends no evidence. On the development agent that machine is the M5, whose contact the live proof requires. A dead machine is the named risk in §9. The recurring maturation review is the arbiter: it may adjust these numbers through its normal procedure, and it opens the fleet-default change when the rung graduates.

## Acceptance criteria

Every "delivered once" below is measured three ways: the fake holder's submit-accepted count is exactly 1, the fake Telegram send count is exactly 1, and exactly one non-retired operation row exists for the reply.

1. **Healthy pool.** A token-less standby with the gate live and a reachable holder: the reply is sealed with the live account and delivered once. There is exactly one capabilities read, exactly one prepare, no placeholder, and no orphan intent record.
2. **Outage, first reply.** The holder refuses connections and there has been no contact since boot. The reply is durably held:
   - a `held` row with reason `HOLD_REASON_LEASE_NOT_HELD`;
   - sealed account `UNRESOLVED_TOKENLESS_ACCOUNT`;

   - owner: the settled holder, or `UNRESOLVED_LEASE_HOLDER` when none settled.

   The route returns that operation id. The script prints its pending text "HELD — not delivered yet…" plus the custody line.
3. **Recovery delivers once.** The holder returns. In one pass, the row is superseded (owner and account resolved) and delivered once, and the original operation id's outcome reads `delivered`. Further cases:
   - (b) The holder accepted but the answer was lost (`outcome-unknown`). Recovery resolves through `receipt` and never re-submits, including when the lease moves while the outcome is unknown.
   - (c) A placeholder row is superseded, then the holder moves. A second supersede keeps the now-concrete account, and the outcome still reads `delivered`.
   - (d) A crash between the supersede and the submit. The next pass submits the superseding row once.
4. **Two replies from one outage, in one topic.**
   - Both are delivered once, in either order, and neither retires the other.
   - Repeat with the older row retained (refused) while the newer one is delivered first. The older row is still delivered later and is not retired.
   - A newer *live* agent message (not from a hold) retires the older held reply, recorded as `overtaken-reply` (#3082), and nothing is sent.
   - A user message alone never retires it.
   - A live correction from a standby whose holder is reachable (no prior hold) arrives unstamped and still retires an older held reply.
   - A newer agent row stamped `forwardedHeld: true` never retires it, whichever machine authored it. Two authoring standbys hold one reply each in the same topic: both are delivered.
   - A newer unstamped row from an old-standby fixture retires it, as today.
   - When the pool read fails, the existing #3082 behavior applies: hold while peers fail, within `QUEUED_REPLY_PEER_WAIT_MS`.
5. **Concrete account change.** Rows sealed for bot A, while the holder now runs bot B, in two topics:
   - nothing is sent;
   - the rows are retained;
   - ONE `account-changed` item lists both topics.

   Also covered: a holder change at the same moment keeps the A seal. A matching account refused with `origin-plan-invalid` keeps today's handling: it is recorded `refused` and re-attempted on later eligible ticks.
6. **Lease flap.** Holder → self (token-less) → holder: the reply is delivered once after the flap, and no `local-sent` marker is ever written.
7. **Unchanged and honest paths.**
   - Machines with a token: the existing forward tests pass unchanged.
   - Token-less with the gate dark: direct relay. A pre-prepare failure answers `not-sent`, the script prints NOT SENT, and the direct relay reads capabilities once.
   - The gate turned dark while held rows exist: they still drain.
   - A blackholed holder with 10 due rows and no custody uncertainty: one network timeout per tick, counting RPCs and pool-history reads. A separate case checks that the shortcut never suppresses the receipt reconciliation an `outcome-unknown` row requires; those rows still each ask their original holder.
   - Clock skew: a live row from another machine within `OUT_OF_ORDER_CLOCK_SKEW_MS` after `preparedAt` does not retire the held reply. One beyond the tolerance does. Both positive and negative offsets are tested.
   - A notice-class send with the holder unreachable: no hold, the item is recorded locally, and `not-sent` is audited. A job-result send under the same conditions is held.
   - The holder records `fired` and `error` feature-evidence rows from `forwardContext`, each event id only once. An old-holder fixture ignores the field.
   - A token-less hold sends metadata-only evidence to every reachable peer once. A peer's `peerHeldDebt` lists it after the deadline when no receipt has arrived, and never includes the text.
   - The `telegram-reply.sh` hash is registered.
8. **Live proof on the real pool.** The Studio's mesh port is briefly blocked from the M5 while the Studio's server keeps running. A reply sent from the M5 lands in topic 141014 after access returns, with no manual resend. Its first operation id resolves `delivered`. The pooled topic history shows that text exactly once, as the M5's stamped row, and that row's Telegram message id matches the holder's receipt. The Studio's `logs/feature-evidence.jsonl` has the matching row.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Outbound route on a token-less machine: durable forward vs direct relay | invariant; basis: enumerable-domain; evidence: three recorded facts (forward switch, dev-gated key, mesh identity) map to exactly one path | Deterministic routing. The conservative default (gate dark) is today's path. |
| Sealing account: live capabilities answer vs `UNRESOLVED_TOKENLESS_ACCOUNT` | invariant; basis: external-constraint; evidence: the holder refuses any sealed account that is not its own with `origin-plan-invalid` before admitting (`OriginMesh.ts:136`), and recovery compares the sealed account with the live one before submitting (§2), so a mismatched seal is never submitted | The seal is a routing hint. Only the placeholder is ever re-sealed automatically. |
| Automatic re-seal only from the placeholder; a concrete mismatch goes to the operator | invariant; basis: irreversible-consequence; evidence: re-sending held content under a bot it was not sealed for could post to a chat that bot should not reach, and a Telegram send cannot be recalled | Removes any authority the holder's answer would have over concrete seals. |
| Held replies do not overtake each other: `forwardedHeld`-stamped rows are excluded from the overtaken review | invariant; basis: irreversible-consequence; evidence: a held reply retired on account of another held reply is an answer lost for good, while the accepted alternative (a stale reply plus its correction, both labelled) is recoverable by reading. Unstamped rows from old standbys keep today's rule | Makes delivery order irrelevant. No head-of-line blocking, and each row keeps its own backoff. |
| Hold deadline for token-less holds (6 h) | invariant; basis: external-constraint; evidence: it is the existing hold deadline every durable forward already uses (`admission.deadlineAt = now + this.#limits.deadlineMs`, `TelegramOriginService.ts:467`; `SIX_HOURS`, `OriginStoreBackend.ts:24`; observed as prepared + 6 h on every Studio operation in the 2026-11-11 diagnosis), inherited unchanged. An outage longer than this expires loudly through the existing expiry item | The spec does not change the deadline. |
| `forwardContext.events` cap (50 events, 16 KB per command) | judgment-candidate; floor: a self-chosen bound that the holder enforces on its side by dropping excess. Dropped events are never acked, so they are resent and nothing is lost. 50 events at about 300 bytes each fits 16 KB. arbiter: the maturation review, through the feature's ladder entry, may adjust it. The 128 KB check at `OriginMesh.ts` ~105 bounds only the signed `envelopeJson`, not the command | A signal can never crowd out or block delivery |
| Notice-class sends are never held | invariant; basis: enumerable-domain; evidence: a fixed list of producer ids (`reply-delivery-notice`, held notice, attention hub, expiry report) | Prevents stale delay notices and expiry loops. |
| `self` route without a local transport: retain without the `local-sent` marker | invariant; basis: irreversible-consequence; evidence: the marker makes a row permanently non-retryable, so writing it when no send can happen strands a reply that was never sent | Equivalent to the existing `settling` retain. |
| Fleet graduation of the gate | judgment-candidate; floor: dark on the fleet until the ladder rung graduates. Harm metrics are at most 0, with basis: irreversible-consequence and evidence: a lost reply cannot be undone. The ran metric is at least 1 re-sealed delivery, with basis: enumerable-domain and evidence: zero vs nonzero is what shows the path was exercised. Soak 7 days and window 14 days, with basis: external-constraint and evidence: the ladder precedent (`usage.ledger` rung), adjustable by the arbiter. arbiter: the recurring maturation review (§10) | The evidence is written on the holder, where the review runs. |

No new blocking authority. No LLM in the loop.

## Frontloaded Decisions

1. **Account source: no cache.** The source is the capabilities answer read at the start of the attempt. If the holder cannot be reached, the existing placeholder is used, and it is re-sealed only in recovery. A cache file was rejected in round 1: it is a second store, it is open to poisoning, and it is empty on the first reply after boot anyway. Replicating the bot token was rejected because it spreads a credential. A configured account id (the id is not secret) was also rejected. Today no machine-shared config carries it, so an operator would have to set it on every token-less machine and keep it right when the bot changes. The live read is needed at every submit anyway, so a configured value would only save the placeholder hop in an outage. A third option, having the holder bind the account at admit so the standby seals only chat and topic, was rejected. It changes the signed origin record and the holder's admission check, which breaks mixed-version pools and widens the change.
2. **Gate and maturation path.** The dev-gated key is `messaging.tokenlessDurableForward.enabled`, a top-level dotted path registered in `src/core/devGatedFeatures.ts` like `messaging.actionClaim.slack.enabled`. Config omits `enabled`, so `resolveDevAgentGate` makes it live on a development agent and dark on the fleet. It reads dark if it cannot be read. The existing `forwardToHolder` switch must also be on. Rungs:
   - (1) test agent: acceptance 1–6;
   - (2) development agent (Echo's M5/Studio pool): acceptance 7, then the `dev-agent-live` ladder rung (§10);
   - (3) fleet: the default flip, opened by the recurring maturation review when that rung graduates.
3. **Capabilities read location.** Exactly once per attempt, before prepare: in `forwardReplyToHolder`, in `recoverForwardedHold` (with a per-holder short-circuit within a tick) and in `relayOriginBot`. The answer is passed into `submitOriginToHolder`.
4. **Concrete account change.** One operator attention item per account pair, with no automatic re-send (§2).
5. **Evidence location.** A command-level `forwardContext` on capabilities and submit, recorded by the holder in its `feature-evidence.jsonl` with acked event ids (§10). It sits outside the signed record, and is a signal only.
6. **Script wording.** Reuse the script's existing `not-delivered` text for `not-sent` (§6). No new user-facing wording.
7. **Custody exception, ratified by approving this spec.** A held, unsent outbound reply is kept only on the authoring standby, with peers recording metadata-only debt (§9). This is the Amendment 6 "Recorded here" Pending pattern, applied to outbound relay holds. Copying reply text to other machines was rejected because it widens where conversation content lives. The operator's `approved: true` on this spec is the explicit ruling that extends the exception to this case, and the approval record names it.
8. **Fleet rollout.** NOT cheap-to-change-after, because it changes durable delivery. It ships dark on the fleet, and the live proof runs on the development agent before merge.

## Multi-machine posture

- **Held operations:** they live on the authoring standby, as they already do for standbys with a token. Each is re-forwarded to whichever machine holds the lease at recovery time. Placeholder seals only are re-sealed to that machine's live account.
- **Bot account id:** proxied-on-read. It is read live from the holder's `capabilities` once per attempt, and nothing is cached.
- **Notices and attention items:** the held notice goes through the holder (one voice). A token-less machine's items are recorded locally (dashboard and pooled attention read). Their hub posts are never held: they are recorded `not-sent` when the holder is unreachable (§8).
- **Mixed versions:**
  - New standby, old holder: the wire format is unchanged. The new standby never submits a placeholder seal, because it reads capabilities first (§1–2). The old holder ignores `forwardContext` and records no evidence, so the rung cannot graduate against an old holder. The new standby still stamps its own rows.
  - Old standby, new holder: unchanged (direct relay).
  - New standby, old holder without a token (`accountId: null`): the row stays on the placeholder until a credentialed holder answers or its deadline passes.
  - New script, old server: no `outcome` field, so today's wording.
  - Old script, new server: it ignores `not-sent` and still prints "MAY ALREADY BE DELIVERED". `migrateScripts` does not overwrite a customized `telegram-reply.sh` (hash mismatch): it keeps the old wording, and the migrator raises its existing degradation event.
- **Upgrade with held rows present:** rows sealed by token machines are unaffected.

## Rollback

Revert the change. Nothing is sent twice. A reverted token-less standby has no recovery wired, so rows still `held` on it are never dispatched. They expire at the existing hold deadline (6 h, `OriginStoreBackend` retention sweep ~1517), with no attention item on that machine. Those replies are lost, which is today's behavior. Rows already superseded or delivered are unaffected, and the release fragment says this plainly.

**The back-out procedure avoids that silent loss.**

1. Turn the gate dark first. Recovery stays wired (§5), so held rows still drain, and an undelivered expiry still raises its attention item.
2. Do a full revert only once `GET /telegram/origins/status` shows zero token-less held rows on every token-less machine.

Following this order, a revert can never quietly drop a reply the agent was told not to resend.

## Related, separately tracked

A token-less standby also never drains its legacy pending-relay queue (`importLegacyQueue` returns without `bot.token`). Nine replies from Nov 5-6 have been stuck there since. This is filed as feedback `fb-930b73b7` and kept separate: those rows are days stale and need a retire-or-forward decision, not this delivery path. This change gives that work the mechanism it needs (sealing with the placeholder and re-sealing on the holder's answer).

## Open questions

*(none)*
