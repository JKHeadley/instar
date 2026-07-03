---
title: Slack Follow-Through Generalization (Phase 2.3)
status: draft
parent-principle: Structure > Willpower
related-principles:
  - The Agent Carries the Loop
  - Close the Loop (Untracked = Abandoned)
  - Deferral = Deletion
roadmap: Phase 2.3 — follow-through generalization
reuses-specs:
  - durable-conversation-identity.md (§5 funnel, §6.1 increment 2, §6.3 eager mint, §7 bind-time authority)
  - action-claim-followthrough-sentinel.md (the Telegram registration model this spec generalizes)
supersedes: none
tags: [draft]
---

# Slack Follow-Through Generalization (Phase 2.3)

> **One line:** A promise the agent makes in a **Slack** conversation must register as a durable commitment — the way a Telegram-born promise already does — so it survives a restart and is delivered by the machinery that already ships. The delivery side is DONE (durable-conversation-identity increment 2, merged + live-on-dev). The **registration TRIGGER on the Slack path is the only missing piece**, and this spec specifies exactly that, reusing the deployed machinery end to end.

---

## §1. Problem & live evidence

**Live evidence (2026-07-03 13:23–13:40 PDT, `docs/audits/session-a-matrix-2026-07.md` §S7).** An admin-seat Slack ask produced a real conversational reply promising *"I'll post the check-in note here in about 5 minutes."* The note was delivered on time — but **no durable commitment was ever registered** (the S7 harness polled `/commitments` at a 10 s cadence and never saw a row). The promise lived only in the responding session's memory; a restart in that window would have silently dropped it. This is the exact failure mode the commitment system exists to prevent, and it is un-prevented on the Slack path.

**Why the promise was dropped:** the Slack conversational session was *told* it could open durable state (the bootstrap prompt literally says *"use it as the topicId when opening durable state"*, `src/commands/server.ts:7642-7647`) — but nothing **structurally** made it do so. That is a **willpower** bootstrap, and willpower failed (Structure > Willpower). On the Telegram path the same class of promise is caught **structurally** by a post-turn Stop hook (the Action-Claim Follow-Through Sentinel). The Slack path has no equivalent wired.

**What is already DONE (do not re-build):** the durable-conversation-identity keystone is merged, deployed (both machines v1.3.737+), and live-on-dev (`conversationIdentity.followThrough.dryRun:false`):

- Slack inbound **eagerly mints** a stable negative conversation id: `conversationRegistry.mintForInbound(routingKey).id` (`src/commands/server.ts:7575`; registry `src/core/ConversationRegistry.ts:942`; §6.3 of durable-conversation-identity, ships live/ungated).
- The Slack spawn already carries the minted id into the session as `bootstrapConversationIds:[conversationId]` (`src/commands/server.ts:7742`), which mints a per-session **bind token** injected as `INSTAR_BIND_TOKEN` (`src/core/SessionManager.ts:561-565`, callsite `:4243-4247`).
- `POST /commitments` already **hard-gates** a durable bind on a minted (negative) id behind that bind token (`src/server/routes.ts:22129-22206`; §7 bind-time authority).
- `CommitmentTracker.record()` already **binds a minted id durably** through `config.conversationBinder.bind()` and denormalizes the `boundTuple` (`src/monitoring/CommitmentTracker.ts:580-587`).
- `PromiseBeacon` already **delivers follow-through into the exact Slack thread** through the `deliverToConversation` funnel's `id<0` arm (`src/monitoring/PromiseBeacon.ts:1359-1369`; server wiring `src/commands/server.ts:13189, 13308-13315`; funnel gate `src/core/deliverToConversation.ts:6-12`, dark-gated behind `conversationIdentity.followThrough`, **live-on-dev**).

**What is MISSING:** the **registration trigger** on the Slack path — the thing that, when the agent makes a promise in a Slack reply, opens the commitment bound to the minted id so the (already-wired) beacon can carry it. This spec is that trigger, and nothing else.

---

## §2. Goal, non-goals, and boundary with durable-conversation-identity §6.1

### §2.1 Goal

When an outbound Slack reply contains a promise, a durable commitment is opened — **bound to the conversation's minted id, on the machine that owns the conversation, idempotently, signal-only, high-precision** — so the existing PromiseBeacon + `deliverToConversation` funnel carry the follow-through across restarts, exactly as they already do for Telegram.

### §2.2 Non-goals (owned elsewhere — do NOT re-specify)

durable-conversation-identity §6.1 already **assigns** the following; this spec depends on them and MUST NOT re-specify them:

| Already-owned (durable-conversation-identity §6.1) | Where |
|---|---|
| Eager Slack-inbound mint / registration of the conversation id | Increment 2 + §6.3 (live) |
| The commitment → funnel follow-through beacon | Increment 2 (live-on-dev) |
| The §7 stateless bind token + `POST /commitments` minted-id gate | Increment 2 (live) |
| `deliverToConversation` funnel + §5.2 bounded-notification budget | Increment 1 (funnel) / §5.2 |
| Cold-start Slack fallback, AutonomousProgressHeartbeat swap, attention-item delivery, reap-notice delivery on minted ids | Increments 3–6 |
| Slack delivery robustness parity (PendingRelayStore lane, DeliveryFailureSentinel `channel:'slack'`, delivery-id idempotency, GFM→mrkdwn) | §5.2 Phase 2.1 non-goals |
| Bespoke conversations replicated store (multi-machine) | Increment 9 |

This spec's **only** surface is the **registration trigger** — a genuinely-deferred Phase 2.3 item (durable-conversation-identity §6.0 names "per-conversation Slack ack UX" and "Slack KYP auto-bind" as Phase 2.3; the registration trigger is the sibling that closes S7).

### §2.3 Explicit non-goals of THIS spec

- No new delivery path (reuse `deliverToConversation`).
- No new commitment store, no new beacon (reuse `CommitmentTracker` + `PromiseBeacon`).
- No LLM in the trigger path — detection stays deterministic (reuse the two pure classifiers).
- No change to the Slack outbound send path or the Slack robustness lane (§5.2 Phase 2.1).
- No new Telegram behavior beyond what riding the shared route naturally yields (see §8.4).

---

## §3. Grounded machinery this spec reuses

Every mechanism below is deployed on v1.3.737 and cited so a reviewer can verify it exists.

1. **The Telegram registration model = the Action-Claim Follow-Through Sentinel.** A thin **Stop hook** (`.instar/hooks/instar/action-claim-followthrough.js`, wired `src/templates/hooks/settings-template.json:198`; body generated by `PostUpdateMigrator.getActionClaimFollowthroughHook()`, `src/core/PostUpdateMigrator.ts:11843-11903`) posts the finished turn's outbound text + topicId to `POST /action-claim/observe`. The hook reads `input.last_assistant_message` (`:11879`, **channel-neutral**) and `process.env.INSTAR_TELEGRAM_TOPIC` (`:11880`, **the Telegram-only seam**), self-gates on `messaging.actionClaim.enabled` (`:11873`, code-default false), and **always exit(0)** (`:11901`, signal-only). It passes **no bind token** today.
2. **The route.** `POST /action-claim/observe` (`src/server/routes.ts:22313-22367`): gate `messaging.actionClaim.enabled` (`:22314`); requires `{message:string, topicId:number}` (`:22323`); classifies via `classifyActionClaim(message)` (`:22328`); dedups on `externalKey = 'actionclaim:'+sha256(topicId|verb).slice(0,16)` (`:22336`); per-topic cap default 5 (`:22338-22349`); auto-expiry default 6 h (`:22350`); records `type:'one-time-action', source:'sentinel'` (`:22352-22361`); never 500s (`:22363`). **It does NOT verify the bind token — the §4.3 gap.**
3. **The action-claim classifier.** `classifyActionClaim` (`src/core/action-claim.ts:115`) — pure, deterministic, **high-precision closed verb set** `relaunch/restart/redeploy/deploy/push/merge/revert/rebase/rerun/fix` (`:41-52`), first-person future/progressive leads, past-tense reject. **FD2 (`:10-14`): fail toward NOT-registering — a false action-claim is a durable nagging commitment.** It does **not** catch conversational time-boxed promises like S7's "I'll post … in about 5 minutes."
4. **The time-promise detector.** `CommitmentTracker.detectTimePromise` (`src/monitoring/CommitmentTracker.ts:1072-1120`) — pure, deterministic; catches `"back in 20 minutes"`/`"in an hour"` (numeric, `:1079-1081`), `"by EOD"` (`:1106`), `"tomorrow"` (`:1109`), `"I'll check in / report back / shortly / soon"` (`:1112-1117`). Today it runs only **inside** `record()` to auto-arm the beacon (`:598-610`) — it is never a **trigger** to call `record()`. **Its numeric regex misses the hedge in "in about 5 minutes"** (`about` breaks `in\s+(an?|\d+)`), so the exact S7 string falls through both classifiers today (see §4.2 / §10-Q1).
5. **Durable bind + idempotency.** `CommitmentTracker.record()` (`src/monitoring/CommitmentTracker.ts:520-679`): `externalKey` open-match short-circuit **before** validation (`:562-565`, a restated promise updates ONE commitment); minted-id durable bind via `conversationBinder.bind()` with a typed throw on refusal (`:580-587`); `boundBy` recorded from the gate, never trusted from the body (`:550-553`).
6. **The §7 bind-time authority (the correct-reuse target).** `POST /commitments` (`src/server/routes.ts:22129-22206`): for a **negative** id it REQUIRES `X-Instar-Bind-Token`, `bindAuth.verify()`s the MAC, and checks the target is in the token's own `bootstrapConversationIds` — else a typed `403 conversation-bind-not-authorized` + one deduped attention item (`:22144-22172`). In-process server callers stamp `boundBy:"server:<component>"` and never traverse the route (`:22134-22135`). Token = `base64url(payload).base64url(HMAC)`, `payload={sessionName,bootstrapConversationIds,mintedAt}` (`src/core/conversationBindToken.ts`), minted at spawn (`src/commands/server.ts:5278-5279`).
7. **Delivery (already live-on-dev).** `PromiseBeacon` → `deliverToConversation` `id<0` arm (`src/monitoring/PromiseBeacon.ts:1359-1369`), gated behind `conversationIdentity.followThrough` (`src/core/devGatedFeatures.ts:168`).
8. **Considered-and-rejected reuse target — the `commitment-detection` job.** It runs (`*/5`, enabled; `src/commands/init.ts:3558-3573`) but writes to the **evolution-actions** ledger via `POST /evolution/actions`, keyed off the Telegram `telegram-messages.jsonl` bookmark — it is **not** the CommitmentTracker/PromiseBeacon durable-commitment path and is Telegram-JSONL-bound. Not reused here (see §11-C).

---

## §4. Architecture — the registration trigger

### §4.1 The chosen trigger: generalize the Action-Claim Stop hook to Slack

**Decision:** the registrant is **the responding session's post-turn Stop hook** — the same Action-Claim Follow-Through Sentinel that registers Telegram-born promises — generalized to the Slack path. The server-side chain (classify → record → bind → beacon → deliver) is already channel-neutral (fork-verified: `deliverToConversation`, `record()`, `PromiseBeacon` never reference a platform). The generalization is therefore **three small seam changes** (§4.4) plus one detection widening (§4.2) plus one authority closure (§4.3) — no new machinery.

**Why the Stop hook / responding session (not a server-side send-chokepoint, not the job):**

1. **It literally generalizes the Telegram model.** The task is "make Slack work the way Telegram already does"; Telegram-born promises register via this exact hook. Generalizing = feeding the hook a Slack conversation id + bind token. This is the most-reuse, least-new-machinery path.
2. **It uses the machinery increment 2 was DESIGNED for.** The per-session bind token exists so a **session** can safely open durable state on its own minted id. The bootstrap prompt already names the session as the intended registrant. The Stop hook is the structural enforcement of that intent (Structure > Willpower).
3. **It keeps the loop-carrier authority with the session that made the promise** ("The Agent Carries the Loop"): the promise is the responding session's obligation, so the responding session's own bind token opens it.
4. **It is naturally scoped to the session's own turn** (one `last_assistant_message` per Stop), avoiding the send-chokepoint's need to discriminate the session's reply from permission-templates / sentinel notices / ephemerals that also traverse `sendToChannel`.
5. **It naturally lands on the owning machine** (§7): the Slack session runs on the Slack-fronting machine (the Mini), and the hook posts to that machine's `localhost`.

(Alternatives — the in-process send-chokepoint classifier, and the `commitment-detection` job — are considered and rejected in §11.)

### §4.2 Detection: two reuse lanes (deterministic, no LLM)

The trigger registers when **EITHER** deterministic classifier fires on `last_assistant_message`:

- **Lane A — action claims:** `classifyActionClaim` (`src/core/action-claim.ts:115`), unchanged. Registers a `one-time-action` commitment keyed on the verb (existing behavior). Not beacon-armed unless the text also carries a time marker (existing `record()` auto-beacon).
- **Lane B — time-boxed conversational promises (the S7 family):** `CommitmentTracker.detectTimePromise` (`src/monitoring/CommitmentTracker.ts:1072`) is **promoted from an inside-`record()` beacon-sniff to a first-class trigger predicate** on the observe route. When it fires, a `one-time-action` commitment is opened with `beaconEnabled:true` and the cadence/deadline it returns — so a "I'll do X in N minutes / by EOD / shortly" promise is durably tracked AND beacon-carried. This is the lane that closes S7 (a time-boxed promise the dev-ops verb set would miss).

**The S7 hedge fix (small, in-scope, reuses the function):** `detectTimePromise`'s numeric regex (`:1079-1081`) misses the hedge in "in **about** 5 minutes" because `about` breaks `in\s+(an?|\d+)`. A one-token widening — `in\s+(?:about\s+|around\s+|roughly\s+|~\s*)?(an?|\d+)\s*<unit>` — makes the exact S7 string register. This is a tested tweak to an existing pure function, not new machinery. (§10-Q1 carries whether to widen recall further.)

**Why deterministic-only:** the trigger must be cheap, total, and audit-clean (it runs on every finished turn). Both classifiers are pure functions with existing unit tests. No LLM hop is added to the turn-completion path.

### §4.3 Authority: enforce the §7 bind token on `/action-claim/observe` for minted ids

**The gap.** `POST /action-claim/observe` calls `commitmentTracker.record()` **without** verifying a bind token (`src/server/routes.ts:22313-22367`). Today that is safe *only* because the hook feeds **positive** Telegram ids, which are under the §7 legacy fail-open policy. The moment the hook feeds a **negative minted Slack id**, §7 becomes **load-bearing**: an unauthenticated caller could open a durable commitment (with a nagging beacon) on a conversation it does not own.

**The closure (reuse, don't rebuild).** For a **negative** `topicId`, `/action-claim/observe` MUST run the **same** bind-token verification `POST /commitments` runs (`src/server/routes.ts:22157-22172`), reusing `ctx.conversationBindAuth`:

1. Require `X-Instar-Bind-Token` (from the hook, §4.4). Missing → typed `403 conversation-bind-not-authorized` + the existing deduped attention item; **fail-closed**.
2. `bindAuth.verify(token)` the MAC. Invalid → same 403.
3. Assert `numericTopicId ∈ payload.bootstrapConversationIds`. Foreign id → same 403 (the exact refusal `POST /commitments` raises).
4. On success, pass `boundBy:"session:<payload.sessionName>"` into `record()` (identical to `POST /commitments`).

For a **positive** `topicId`, behavior is **unchanged** (legacy fail-open + the R7-minor-2 straggler backstop), so the Telegram path is byte-identical. The verification block is **shared code** with `POST /commitments` (factor the §22129-22206 block into one helper both routes call — a refactor, not a second implementation; a second copy would be the kind of drift the §7 golden test forbids).

**Net:** the Slack session self-registers under **its own** authority (its `INSTAR_BIND_TOKEN`, scoped to its minted id); no other principal can open a commitment on that conversation; in-process callers are unaffected.

### §4.4 The seam changes (exhaustive — this is the whole build)

1. **Spawn env (`src/core/SessionManager.ts` ~:4271).** Inject a **channel-neutral** `INSTAR_CONVERSATION_ID=<bootstrapConversationIds[0]>` whenever a bootstrap conversation id is present (alongside the existing Slack env at `:4272-4281`). For Telegram this equals the positive topic id (consistent); for Slack it is the minted negative id. `INSTAR_BIND_TOKEN` is already injected (`:4243-4247`).
2. **The Stop hook (`PostUpdateMigrator.getActionClaimFollowthroughHook`, `src/core/PostUpdateMigrator.ts:11843-11903`).**
   - Topic source: prefer `process.env.INSTAR_CONVERSATION_ID`, fall back to `process.env.INSTAR_TELEGRAM_TOPIC` (legacy sessions spawned before change 1). Accept a **negative** parsed id (drop the implicit "must be a Telegram positive" assumption; `Number.isFinite` already admits negatives).
   - Bind token: read `process.env.INSTAR_BIND_TOKEN`; when set, send it as the `X-Instar-Bind-Token` header on the POST.
   - Everything else (last_assistant_message, `messaging.actionClaim` gate, `always exit(0)`) unchanged. Regenerated on every migration (`instar/` hooks are always-overwritten — §8.5).
3. **The route (`src/server/routes.ts` `/action-claim/observe`, :22313).** Add the §4.3 negative-id bind-token gate (shared helper) + the §4.2 Lane-B `detectTimePromise` predicate + Lane-B `externalKey` (§5) + Lane-B `beaconEnabled` pass-through. Both lanes ride the existing per-topic cap + expiry + never-500 contract.

### §4.5 Which process owns registration — summary

The **responding Slack session** owns registration, via **its own post-turn Stop hook**, posting to **its own machine's** server, under **its own** bind-token authority. The server-side route + record + beacon + funnel are shared, channel-neutral, and already deployed.

---

## §5. Idempotency & dedup

- **Lane A (action claims):** unchanged — `externalKey='actionclaim:'+sha256(topicId|verb).slice(0,16)` (`src/server/routes.ts:22336`). A restated action claim across turns updates ONE commitment (`record()` short-circuit, `CommitmentTracker.ts:562-565`).
- **Lane B (time-boxed promises):** `externalKey='timepromise:'+sha256(topicId|normalizedPromiseText).slice(0,16)`, where `normalizedPromiseText` = lowercased, whitespace-collapsed, time-token-preserving slice of `last_assistant_message`. An **exact restatement** dedups to ONE commitment; a **reworded** restatement opens a new one (weaker than the verb anchor). The **per-topic cap (default 5, `messaging.actionClaim.perTopicCap`)** bounds the blast radius of reworded restatements; auto-expiry (6 h) sweeps stale rows. (§10-Q2 carries whether Lane B needs a stronger cross-restatement anchor.)
- **Cross-machine idempotency** is inherited: a commitment is created only on the owning machine (§7), and the minted id + `boundTuple` are that machine's; a peer never opens a competing row (write-admission refuses a minted-id write on a non-owner, and the bind token verifies only against the owner's secret).

---

## §6. Failure directions & the precision-over-recall trade

The trigger is **signal-only**: it runs **after** the Slack reply has already been sent (the Stop hook fires at turn end; the reply went out during the turn). It can NEVER block, delay, or rewrite a message.

**Named trade — bias to PRECISION over RECALL:**

- A **false** registration is real, durable harm: a spurious PromiseBeacon heartbeat posted **into the user's Slack thread**. (This is the FD2 rationale already baked into `classifyActionClaim`, `action-claim.ts:10-14`.)
- A **missed** registration is the **status quo** gap (the promise is untracked, as it is today) — a non-regression.
- Therefore the trigger fails toward **not-registering** and toward **no-duplicate**: both classifiers are high-precision; ambiguity → no registration; a restatement dedups (§5).

**"Never lose the promise silently" — the two failure classes and where each surfaces:**

1. **Refused registration** (bind-token invalid, capacity, `conversation-recording-disabled`, or `followThrough` dark/dry): **never silent.** The §7 refusal raises the deduped `conversation-bind-not-authorized` attention item (`src/server/routes.ts:22144-22156`); a minted-id bind while delivery is dark raises the §6.1 dark-window-honesty item (`src/server/routes.ts:22225-22239`). Both route through the existing attention surface (Telegram lifeline / `slack-attention-channel` mirror), never the dark minted-id funnel.
2. **Missed classification** (neither lane fired): **silent by design** — this is the accepted recall trade above. It is bounded by the two detectors' coverage and improved only by §10-Q1's recall knob.

**We NEVER fail toward:** a duplicate commitment, a spurious beacon, or a commitment on a conversation the caller does not own (§4.3 fail-closed).

---

## §7. Multi-machine reality — register on the owning machine, structurally

The **Mini** fronts Slack (serving-lease holder); Slack inbound + `mintForInbound` run on the Mini (`src/commands/server.ts:7575`), so **the Mini owns the minted conversation id and its registry row**. Registration MUST happen there. This is enforced **by construction**, not convention:

1. The Slack conversational session is spawned **on the Mini** (`spawnInteractiveSession`, `src/commands/server.ts:7742`), so its Stop hook posts to the **Mini's** `localhost` server.
2. The session's `INSTAR_BIND_TOKEN` is minted by the **Mini's** `conversationBindAuth` using the **Mini's** `bindTokenSecret` (`src/commands/server.ts:5278-5279`), so it verifies **only** on the Mini. A hook that somehow posted to a peer would be `403`-refused (different secret) — fail-closed, not a wrong-machine write.
3. `record()`'s `conversationBinder.bind()` resolves the minted id against the **local** registry (`CommitmentTracker.ts:580-587`); a peer that never minted the id would throw `conversation-bind-unresolvable` → `409`, not a silent divergent row.
4. Write-admission refuses a minted-id durable write on a non-owner machine (the general standby-write policy), so a peer cannot open the row even if the other guards were bypassed.

**Conversation moves (out of scope, already handled):** if the topic later moves machines, the commitment's denormalized `boundTuple` travels with it and `PromiseBeacon` re-resolves the live owner at speak time (`src/commands/server.ts:13321-13325`) — increment-2 machinery, not re-specified here.

---

## §8. Rollout, config, kill-switch, migration parity

### §8.1 Graduated rollout (dev-gated dark → dev live → operator fleet flip)

- **Trigger gate:** a **new** dryRun-first, dev-gated flag `messaging.actionClaim.slack` = `{ enabled?: omitted, dryRun: true }`, registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`), so `resolveDevAgentGate` flips it **live-on-dev, dark-on-fleet** (the same pattern as `conversationIdentity.followThrough.enabled` at `:168`). `enabled` is **OMITTED** — never materialized as a literal `false` (the #1001 trap).
- **dryRun semantics:** while `dryRun:true`, the observe route runs the full classify + bind-verify + would-register decision and **audits** it (a `would-register` line + the typed bind verdict), but performs **no** `record()`. A deliberate `dryRun:false` on dev enables real registration for the live proof (§9.4).
- **Delivery gate:** unchanged — follow-through delivery rides `conversationIdentity.followThrough` (already live-on-dev). Registration can green (dev) before or after delivery; the §6.1 dark-window-honesty item covers the "registered but delivery dark" window.
- **Fleet flip:** the operator flips `messaging.actionClaim.slack.dryRun:false` (and, when the fleet-wide action-claim rollout lands, `messaging.actionClaim.enabled`) after a measured clean dev soak. Never automatic.

### §8.2 Kill-switch

`messaging.actionClaim.slack.dryRun:true` (or removing the block) reverts to observe-only; `messaging.actionClaim.enabled:false` (fleet default) makes the hook `exit(0)` before any POST (`PostUpdateMigrator.ts:11876`). Both are read **live** from `.instar/config.json` on each turn (no restart). The master off-switch is `messaging.actionClaim.enabled` (the whole sentinel).

### §8.3 Config shape

```jsonc
"messaging": {
  "actionClaim": {
    // existing (whole sentinel; fleet-default false, dev-first)
    "enabled": false,
    "perTopicCap": 5,
    "expiresHours": 6,
    // NEW (this spec) — the Slack registration lane, dryRun-first dev-gated:
    "slack": {
      // "enabled": OMITTED — resolveDevAgentGate resolves it (live-on-dev, dark-fleet)
      "dryRun": true   // true-FIRST; a would-register audit before real registration
    }
  }
}
```

### §8.4 Telegram-path impact (deliberate, bounded)

Adding the Lane-B `detectTimePromise` predicate to the **shared** observe route means a Telegram time-boxed promise ("I'll check in in 20 min") would ALSO register once `messaging.actionClaim.enabled` graduates on the fleet — a strict improvement, riding the SAME dark gate + dev soak. This is intended (one classifier set, both channels) and is called out so a reviewer does not read it as accidental scope leak. No change to Telegram delivery, dedup, or the positive-id authority path.

### §8.5 Migration parity (existing agents get it on update)

- **Hook body** (`getActionClaimFollowthroughHook`): `instar/` hooks are **always-overwritten** on every `migrateHooks()` run (`src/core/PostUpdateMigrator.ts:3462-3463`) — deployed agents receive the generalized hook automatically. No install-if-missing.
- **Spawn env** (`INSTAR_CONVERSATION_ID`): code — ships with the server; no config migration.
- **Config default** (`messaging.actionClaim.slack.dryRun`): added to `migrateConfig()` existence-checked (only add `dryRun:true` if absent; **never** materialize `enabled:false`), mirroring the `conversationIdentity` migration parity note (durable-conversation-identity §6.2(c)).
- **Route** (`/action-claim/observe` bind gate + Lane B): code.
- **Agent-awareness** (CLAUDE.md template): extend the existing Action-Claim paragraph (`src/core/PostUpdateMigrator.ts:4526`) to note it now covers Slack conversations + time-boxed promises.

---

## §9. Testing (three tiers + live proof)

### §9.1 Tier 1 — unit (`tests/unit/`)

- `classifyActionClaim` on Slack-flavored replies (unchanged coverage; regression that the verb set is untouched).
- `detectTimePromise` **hedge fix**: `"in about 5 minutes"`, `"in ~10 min"`, `"in around an hour"` now return a non-null cadence; `"in 5 minutes"` unchanged; negative/absent time → null.
- Lane-B `externalKey` derivation: exact restatement → same key; reworded → different key; cap-bounded.
- §4.3 bind-verify helper: negative id + valid token in bootstrap set → `boundBy` set; negative id + missing/invalid/foreign token → typed refusal; positive id → legacy pass-through. (Shared with the `POST /commitments` §7 test — assert ONE implementation.)

### §9.2 Tier 2 — integration (`tests/integration/`, full HTTP pipeline)

- `POST /action-claim/observe` with a **negative** topicId + a valid `X-Instar-Bind-Token` + a time-promise message → `201`-shaped `{registered:true, beaconEnabled:true}`, and `GET /commitments` shows the row bound to the minted id with the denormalized `boundTuple`.
- Same with **no** bind token → `403 conversation-bind-not-authorized`, no row, and the deduped attention item present.
- Same with a **foreign** minted id (not in the token's bootstrap set) → `403`, no row.
- Idempotency: two identical observes → ONE row; per-topic cap enforced at 5.
- dryRun: `messaging.actionClaim.slack.dryRun:true` → would-register audit line, **no** row.
- Feature-off (`messaging.actionClaim.enabled:false`) → `{observed:false, reason:'feature-disabled'}`, no row (503-equivalent honesty).

### §9.3 Tier 3 — E2E lifecycle (`tests/e2e/`)

Production-init path (mirrors `server.ts` boot): spawn a real Slack-keyed interactive session against a stubbed Slack adapter, verify the session env carries `INSTAR_CONVERSATION_ID` (negative) + `INSTAR_BIND_TOKEN`; drive one finished turn whose `last_assistant_message` contains a time-boxed promise; assert the Stop hook posts to `/action-claim/observe` and a commitment row appears bound to the minted id — i.e. **the feature is alive** (the single most important test).

### §9.4 Live-proof clause (the S7 round-trip — required before "done")

Per the **Live-User-Channel Proof Before Done** standard, a user-role session drives the real Slack surface end-to-end on dev (`messaging.actionClaim.slack.dryRun:false`, `conversationIdentity.followThrough.dryRun:false`):

1. **Promise:** user-role posts a Slack ask; the agent replies with a time-boxed promise ("I'll post the check-in note here in about 5 minutes").
2. **Registered:** within one turn, `GET /commitments` on the **Mini** shows a beacon-armed commitment bound to the thread's minted id (the exact S7 assertion that failed at a 10 s poll).
3. **Bounce the Mini:** restart the Mini's server (the durability test the original promise would have failed).
4. **Delivery lands in-thread:** after restart, the PromiseBeacon heartbeat / follow-through is delivered **into the same Slack thread** via `deliverToConversation`.
5. Record a signed PASS scenario matrix (happy-path, channel-parity vs Telegram, restart-lifecycle, permission/volatile on a throwaway agent + demo channel, refusal/rollback with a bad bind token, idempotency, regression). North-star metric: **operator-found escapes = 0**.

---

## §10. Open questions (carried to the operator via the eli16)

- **Q1 — Detection recall knob.** Lanes A+B (+ the hedge fix) close the S7 case and the dev-ops/time-boxed families. Do we stop there (highest precision), or widen Lane B's recall to catch bare-verb conversational promises ("I'll send you the summary", "I'll wire that up") that carry **no** time marker? Widening buys recall at the cost of false nagging-beacons (the FD2 harm) and is the riskier, LLM-tempting direction. **Recommendation: ship A+B+hedge first; treat further recall as a separately-soaked follow-up.**
- **Q2 — Lane-B dedup strength.** Lane B keys on normalized promise text, so a **reworded** restatement of the same promise opens a second (cap-bounded, expiring) commitment. Is the per-topic cap + 6 h expiry an acceptable bound, or does Lane B need a coarser per-topic-time-window anchor (fewer duplicates, but risks collapsing two genuinely-distinct promises)? **Recommendation: ship the content-hash key + cap; revisit only if dev soak shows duplicate churn.**
- **Q3 — Telegram time-promise registration (§8.4).** The shared route means Lane B also starts registering Telegram time-boxed promises when the fleet flag graduates. Intended improvement, or should Lane B be Slack-scoped until a separate Telegram soak? **Recommendation: keep it shared (one classifier set), rely on the shared dark gate + dev soak.**
- **Q4 — Should a server-side backstop exist?** The Stop hook can be absent on a session spawned before the migration, or crash. Do we want a low-frequency `commitment-detection`-style backstop that scans Slack conversation transcripts for missed promises (recall insurance), accepting its cadence lag and cost? **Recommendation: NO for Phase 2.3 (keep minimal); the always-overwrite hook migration (§8.5) closes the stale-hook window, and recall-insurance is Q1's territory.**

---

## §11. Alternatives considered & rejected

- **A. In-process outbound-send classifier** (classify at the `POST /slack/reply/:channelId` / `sendToChannel` chokepoint, register in-process with `server:` authority). **Rejected as primary:** it does not generalize the Telegram model (a different mechanism), it must discriminate the session's reply from permission-templates / ephemerals / sentinel notices that share `sendToChannel`, and it centralizes authority away from the loop-carrying session. It **is** the natural **backstop** if hook-firing reliability proves insufficient (revisit under §10-Q4) — but it is not needed to close S7 and adds new machinery, so it is out of scope.
- **B. The responding session calls `POST /commitments` directly** (no hook) — this is the **willpower** path the bootstrap prompt already tries (`src/commands/server.ts:7642-7647`) and that S7 proved fails. Rejected: not structural.
- **C. Extend the `commitment-detection` job to Slack.** Rejected: it writes to the **evolution-actions** ledger (`POST /evolution/actions`), not `CommitmentTracker`/`PromiseBeacon`; it is cadence-delayed (`*/5`) — the exact 10 s window S7 shows is fatal — and it is Telegram-JSONL-bound (`src/commands/init.ts:3558-3573`). It is a parallel system, not this path.
- **D. A new bespoke Slack-promise route / store.** Rejected outright: maximal new machinery, exactly what review rounds shred; every needed primitive already exists.

---

## §12. Build sequencing (for the /instar-dev increment that follows convergence)

1. `detectTimePromise` hedge fix + unit tests (isolated, no wiring).
2. Factor the `POST /commitments` §7 bind-verify block (`routes.ts:22129-22206`) into a shared helper; prove `POST /commitments` unchanged.
3. `/action-claim/observe`: add the negative-id bind gate (shared helper) + Lane-B predicate + Lane-B `externalKey` + dryRun audit; integration tests.
4. `INSTAR_CONVERSATION_ID` spawn env (`SessionManager.ts`).
5. Generalize the Stop hook body (`getActionClaimFollowthroughHook`) — topic-source fallback + bind-token header; hook regression (no-bare-require, always exit 0).
6. `messaging.actionClaim.slack` dev-gate registration + `migrateConfig` existence-check + CLAUDE.md template paragraph.
7. E2E aliveness test.
8. Live-proof S7 round-trip on dev (§9.4); signed matrix.

Each step is independently testable; steps 1–3 are shippable behind the dark gate before the Slack env/hook seam exists.
