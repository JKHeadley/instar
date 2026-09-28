---
title: "Dashboard door + model controls (Sessions tab)"
slug: "dashboard-door-model-controls"
author: "echo"
requested-by: "Justin (Telegram topic 112490, 2026-09-27)"
parent-spec: "TOPIC-PROFILE-SPEC.md"
eli16-overview: "docs/specs/dashboard-door-model-controls.eli16.md"
review-convergence: "2026-09-28T02:45:24.464Z"
review-iterations: 6
review-completed-at: "2026-09-28T02:45:24.464Z"
review-report: "docs/specs/reports/dashboard-door-model-controls-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 1
contested-then-cleared: 0
approved: true
approved-by: "Justin (verified operator, Telegram topic 112490)"
approved-at: "2026-09-27T19:24:00-07:00"
approval-note: "Approved with one removal: no PIN requirement (applied before the retry convergence run)."
---

# Dashboard door + model controls

Vocabulary: a **door** is the agent framework a session runs through (`claude-code`, `codex-cli`,
`gemini-cli`, …); a **model** is the model id that door launches with. The dashboard uses the
operator's words ("Door", "Model"); the API keeps the parent spec's `framework` / `model` fields.
Other local terms used below: **regime** = the topic-profile write mode (`fully-live` /
`dry-run` / `disabled`); **husk** = a topic-profile entry whose `current` is null (left by clear,
breaker revert or an unpinned transfer); **dark** = a feature that is built but switched off;
**hold** = a scoped piece of the ask deliberately not built in v1, tracked with an expiry;
**carrier** = the component that moves a topic's pin between machines; **placing** / **lease
holder** = pool ownership states (a topic is being placed on a machine; the machine currently
routing inbound messages); **unified** = the constitution's default posture "one agent across
machines, same state everywhere".

## 1. Problem

The operator can already pin a topic to a door (framework: `claude-code`, `codex-cli`, …) and a
model through the topic-profile system (TOPIC-PROFILE-SPEC), and a pin change respawns the
topic's session in place with the conversation preserved. But the only human surfaces are
conversational ("use codex here") and the `/topic` Telegram command. The dashboard — the
operator's phone-first control surface — has no control for any of it. The operator asked for
three things, all in the Sessions tab:

1. Choose the door + model when creating a new topic from the dashboard.
2. Switch an existing topic's door + model from the dashboard.
3. Choose, from the dashboard, the default door + model that new Telegram-created topics start on.

TOPIC-PROFILE-SPEC §12 deliberately deferred dashboard work. This spec is that deferred work.

**Scope of v1, stated up front:** asks #1 and #2 ship in full. Ask #3 ships as the default used by
the New Session modal and by every dashboard-created topic. Seeding of topics the operator creates
directly in Telegram is HELD (§6, issue #2085) — on a two-machine agent the "is this topic new"
rule proved timing-dependent in review, and on a single machine the machinery could not be
exercised on Echo (a pool) before shipping, so it would have gone out unproven.

## 2. What exists today (grounded; corrected across rounds 1–2)

- `GET /topic-profile/:topicId` — resolved framework/model/thinking/effort + sources + pin.
- `POST /topic-profile/:topicId` (Bearer + `X-Instar-Request: 1`) — writes a pin via
  `topicProfileWriteSurface.applyWrite`. Its principal is `operator | token` only
  (`src/core/topicProfileWriteSurface.ts:68-70`); a **token write to a topic with no bound operator is
  refused** (`:715-724`, parent §10.1) — this includes `clear`. Every accepted write posts a
  disclosure line into the topic (`:386-390`); a framework change outside the fully-live regime goes
  to `legacyFrameworkRespawn` (kill + respawn, `:333-348`). A model-only patch on the fleet is
  refused whole (`:265-276`).
- The store's single-writer `mutate(key, patch)` runs under `withTopicLock` (`TopicProfileStore.ts:326-400`);
  `updatedBy` starting with `system:` is treated as a non-operator write (`:378`). The legacy seed
  (`:723-729`, `system:legacy-seed`, `previous: null`) assigns `entry.current` directly inside the
  seeding routine — it does not go through `mutate`. Undo on a `system:` entry with `previous: null`
  answers `nothing-to-undo` (`topicProfileWriteSurface.ts:423`). Entries can exist as husks with
  `current: null` after `clear`, an unpinned transfer pull (`replaceEntry`, `:441-466`) or a breaker
  revert (`parkAndRevert`, `:522-538`); `store.get(key)` is `null` only when no entry exists at all — and `entryFor` (`:863-869`) inserts a `current: null` husk BEFORE a refused mutate
  throws, so a refused write on a key blocks a later `mutateIfAbsent` (`present`); harmless for a
  create, where the seed is the first write.
- **Write regime, not a 503 gate:** store, resolver and write surface are built unconditionally
  (`server.ts:6545-6549`, `isDryRun: () => topicProfilesCfg?.dryRun !== false`). `topicProfiles.enabled`
  sets the write REGIME: framework arm live in every regime; new axes (model/tier/thinking/effort)
  shadowed under dry-run (visible as `intendedProfile`) and refused (`refusedFields`) on the fleet.
  Routes answer 200 everywhere. On Echo (dev agent) `topicProfiles.dryRun` is `false` (fully live).
- **Spawn paths.** `spawnSessionForTopic` (`server.ts:1036`; resolve at `:1248`, spawn options at
  `:1357-1365`) is the one path that resolves the profile. It is called by the Telegram cold-spawn
  callsite (`:3038-3051`, inside the `spawningTopics` guard; `registerTopicSession` at `:3051`),
  respawn (`:1499`), the resume queue (`:10171/:10478`), the moved-topic spawn (`:22989`, after
  `onTopicAcquired` at `:22889`) and profile respawn (`:27592`). **`POST /sessions/create` does NOT**
  resolve — it calls `spawnInteractiveSession(undefined, name, { telegramTopicId })`
  (`routes.ts:11362-11416`) and then hand-writes `topic-session-registry.json` with a raw
  non-atomic `writeFileSync` (`:11410-11418`) — a file the Telegram adapter owns and rewrites
  atomically from its in-memory Maps (`TelegramAdapter.ts:4727-4740`), so the next adapter
  `saveRegistry()` clobbers the route's entry. Slack / WhatsApp / iMessage spawns never touch the resolver.
- **Registry semantics.** `topicToName` is an "ever NAMED" ledger, not "ever spawned": the adapter
  writes it on the `forum_topic_created` service message (`TelegramAdapter.ts:4896-4905`) and in
  `createForumTopic` (`:1642`), both BEFORE any spawn; the cold-spawn callsite also resolves + persists
  the name before spawning (`server.ts:3041-3045`). `topicToSession` is a LIVE-BINDING map: written
  after a successful spawn (`registerTopicSession`, `TelegramAdapter.ts:2463`) and DELETED by
  `unregisterTopic` (`:2474-2477`) on `/unlink` and on the flag-gated G3 binding-cleanup-on-kill —
  so neither map says "ever spawned here". On a single-machine agent the ownership registry is
  `InMemorySessionOwnershipStore` (`server.ts:22077`), empty after every restart. `findOrCreateForumTopic`
  REUSES a same-name topic and returns `reused: boolean` (`:1690-1703`). Telegram forum topic ids
  are unique per group.
- Resolution: framework arm = pin > `configTopicFrameworks` (merged `topicProfiles.defaults` +
  legacy `topicFrameworks`) > global default (`_defaultFramework`, boot snapshot of
  `sessions.framework`) (`TopicProfileResolver.ts:146-156`). Model arm = pin > config default >
  `frameworkDefaultModels` > account default. `admissibility(fw)` (private, `:331-343`) returns
  `null | 'framework-unlaunchable' | 'grok-interactive-ungated'`; a probe ERROR inside `isLaunchable`
  becomes `ok = true` (`:371-377`) and is indistinguishable from a verified binary. Results are
  cached with a TTL (`:349-351`).
- Valid ids: `KNOWN_MODEL_IDS[fw]` (`pi-cli` is `[]`), `PER_TOKEN_LANE_MODEL_IDS[fw]` deny sets,
  `SUPPORTED_FRAMEWORKS` (enum). `enabledFrameworks` is NOT checked by `validateProfileFields`.
- `GET /sessions` reports `platform` + `platformId` per session (`routes.ts:10300-10315`).
  `dashboard/index.html:4583` injects `session.model` into innerHTML unescaped (inert today because
  model ids are closed-enum after validation).
- Transfer carrier: `onTopicAcquired` is fire-and-forget — the spawn never waits
  (`TopicProfileTransferCarrier.ts:22-24`), but the pending-pull STAGING is synchronous
  (`:266-290`, acquiring side): EVERY key with a real previous owner is staged, pinned or not, and
  `hasPendingPull` reads staged ∪ the durable ledger — stronger than a pin check
  (`:137` is the SERVE side, which answers `present:false` for an unpinned topic); `hasPendingPull(key)` (`:394`) is
  the staleness signal; a local token/http write cancels a pending pull
  (`topicProfileWriteSurface.ts:142,301`). The replicated placement/ownership journal is readable
  in-process (`server.ts:703` `_ownershipReadForDrain(sessionKey)`; materialized on the target at `:22049`).
- Dashboard operator session: `/dashboard/unlock` (`AgentServer.ts:1188+`) issues a memory-only
  token (15-min TTL, `src/server/DashboardOperatorSessionStore.ts:18`; lost on reload) exposed client-side as
  `getOperatorSessionToken` (`index.html:4214,4262,9814,9879`) and sent as `X-Instar-Operator-Session`
  (`subscriptions.js:1259`); routes verify it via `ctx.verifyDashboardOperatorSession?.()`
  (type `routes.ts:918`, use `:21195`, `:31931-35`; optional-chained — an install without it answers 401).
- Replicated-record precedent: `TopicPinReplicatedStore` (advisory copy in a SEPARATE store, never
  the authoritative local one, `TopicPinReplicatedStore.ts:15-19`); gated via
  `multiMachine.seamlessness.ws13PinReplicate`, NOT `stateSync.<store>` (`server.ts:5045-5064`).
  The WS2 memory-family stores use `multiMachine.stateSync.<store>`. A new kind costs schema +
  register + emitter (~100 lines) + fold view (~300) + stores-map entry. Received records are
  revalidated on fold in the topic-profile precedent (`replaceEntry` `revalidate`, `:424-439`).
  HLC skew is bounded (≤15 min, `HybridLogicalClock.ts:62-64`); far-future stamps are quarantined.

## 3. Design

Occam rule for the whole spec: **the new-topic default is read ONLY when a topic is created from the
dashboard, and written as that topic's ordinary pin.** No live resolver layer, no stamp-on-spawn, no
snapshot pass, no inference about whether a Telegram topic is new. Existing topics never read the
default, so "existing topics keep their choice" holds by construction; with no default set,
resolution is byte-identical to today.

### 3.1 `GET /topic-profile/options` (Bearer)

What the dropdowns may offer on THIS machine:

```json
{
  "regime": "fully-live",
  "doors": [
    { "framework": "claude-code", "label": "Claude Code", "available": true, "availability": "verified", "reason": null,
      "models": ["claude-opus-5-5", "..."], "defaultModel": "claude-opus-5-5" },
    { "framework": "codex-cli", "label": "Codex", "available": true, "availability": "verified", "reason": null,
      "models": ["gpt-5.6-sol", "gpt-6-astra", "..."], "defaultModel": "gpt-5.6-sol" }
  ],
  "newTopicDefault": { "framework": "claude-code", "model": null, "updatedAt": null, "updatedBy": null,
                       "replication": "local-only" }
}
```

- `doors` = `enabledFrameworks` ∩ `SUPPORTED_FRAMEWORKS` (all supported when `enabledFrameworks`
  is unset). `models` = `KNOWN_MODEL_IDS[fw]` minus `PER_TOKEN_LANE_MODEL_IDS[fw]`. Every door also
  carries the implicit option `model: null` = "account default" (the only option for pi-cli, whose
  list is empty); `model: null` is ALWAYS selectable for a selectable door — it means "no model
  pin; the account's default at launch time", and the dashboard does not preflight what that
  default resolves to (a later unknown/denied account default follows the launch-time fallback path
  exactly as a framework-only conversational pin does today). `defaultModel` =
  `frameworkDefaultModels[fw]` NORMALIZED through the same §3.5
  check: if the configured default is unknown, denied or unavailable it is reported as `null` with
  `defaultModelDropped: "<reason>"` (never offered, never preselected) — a tested invariant. A
  non-selectable entry that the chat/API path would still accept carries `chatOnly: true`, and the
  disabled row's copy says "you can still pin this in chat".
- **Inventory vs selectable.** `doors` is the INVENTORY (every enabled+supported door, listed for
  visibility even when unavailable). Each door additionally carries `selectable: boolean`: the route
  runs every `{framework, model}` — including `{framework, model: null}` — through the same check
  the write paths use (§3.5), and an entry is `selectable` iff it passes. The UI offers only
  selectable entries and renders the rest disabled with their reason. Parity tests assert that every
  `selectable` option is accepted by the write path and every non-selectable one is refused.
- Door-level admissibility is REPORTED, never used to drop a door from the inventory; only
  `{fw, model}` pairs failing enum / deny-set / enabled checks are non-selectable. `available` /
  `availability` / `reason` come from `TopicProfileResolver.admissibility(fw)` made public and
  widened to a tri-state (the launchability cache changes shape from `{ok, at}` to
  `{ok, availability, at}`, same TTL): `isLaunchable` (`:349-380`) records WHY it answered `ok`, so the
  route reports `availability: "verified" | "assumed" | "unavailable"` — `assumed` when the probe
  errored or had nothing to check (null binary path / empty PATH) and the resolver fell open. The
  two existing callers of the private `admissibility` keep their binary semantics (a wrapper, not a
  signature change on them).
  `available = availability !== "unavailable"` keeps write-path parity (the spawn path still fails
  open, unchanged). The UI shows `assumed` as "(not verified)" and `unavailable` disabled with its
  `reason` — in the inventory, never hidden. Cheap: cached with the existing TTL.
- `regime` = `fully-live` / `dry-run` / `disabled`. The UI states plainly: under `dry-run` a chosen
  model is recorded as intent, not applied; under `disabled` (fleet today) the door switch works and
  the model is refused. Registered before `/topic-profile/:topicId`.

### 3.2 New-topic default (creation-time only)

- Store: `state/new-topic-default-profile.json` → `{ framework, model | null, updatedAt, updatedBy }`,
  atomic write, read live. `framework` is required, `model` optional. Absent ⇒ nothing changes anywhere.
- `POST /topic-profile/new-topic-default` — Bearer + `X-Instar-Request: 1`, exactly like
  `POST /topic-profile/:topicId` (no operator-session / PIN step: **operator decision 2026-09-27
  19:24 PDT, topic 112490 — "remove the PIN requirement, it's really annoying and doesn't provide
  any safety for what we're doing"**; the dashboard's normal login already holds the Bearer token
  that can switch any bound topic onto any door; the one thing this feature adds to that token —
  pinning a just-created, not-yet-bound topic — is named in §4 as a new write path and audited). Body validated per §3.5; `{ clear: true }` deletes the record. Rate-limited
  (5/min). Stated plainly so the trust model is not mistaken for an oversight: ANY holder of the
  Bearer token — the dashboard, or one of my own agent sessions — may change this default, exactly
  as any such holder may already switch any bound topic onto any door; the "dashboard operator
  session" IS the PIN unlock, so requiring it would be the PIN by another name. A non-dashboard
  write is still attributable (`viaOperatorSession: false`) and reversible (`{clear:true}` or the
  next write). Every change is appended to `logs/topic-profile-changes.jsonl` with
  `topicKey: "*new-topic-default*"` (principal `api-token`, when, old → new — plus
  `viaOperatorSession: true|false`, stamped from whether a valid `X-Instar-Operator-Session`
  accompanied the request; attribution only, never a refusal, so the audit can tell a dashboard
  human from an agent session holding the same Bearer), and the sheet confirms the saved value on
  screen. No attention item: the operator just performed the action
  through the dashboard, so a notice would be routine confirmation (Conservative Outbound — act,
  don't notify);
  the audit row is the record, and every topic the default later seeds carries its own disclosure
  line. Registered before `/topic-profile/:topicId` (both the GET and the POST, so `new-topic-default`
  is never captured as a topic key).
- **Where it is consumed — exactly ONE place: `POST /sessions/create` (§3.3)**, when the request
  carries no explicit framework/model. The New Session modal also PRESELECTS its Door/Model from the
  default (`GET /topic-profile/options` → `newTopicDefault`), so a dashboard create with no change
  and a dashboard create with an explicit pick are the same thing from the operator's side.
  Topics created directly in Telegram are NOT seeded in v1 (named hold, §6, issue #2085): their first
  session runs on the global defaults exactly as today. Why: the "is this Telegram topic new" rule
  drew a design finding in every convergence round from 3 to 9 on a two-machine agent (the last
  showed it timing-dependent — a confirmed fresh placement is epoch 2 `active`,
  `SessionOwnership.ts:117-121`, and the peer reads after a history fetch), and the single-machine
  variant (a durable `topicKnownAt` ledger + boot backfill + corrupt-registry salvage) could not be
  exercised on Echo — a pool — before shipping. Shipping a ledger/backfill system that the dev agent
  never runs is invented, unproven work; it moves to #2085 where it is designed once with the
  topic-ownership record as the sole newness signal, together with the replicated default.
- **How it is applied — a store-level seed, never `applyWrite`:** a new
  `TopicProfileStore.mutateIfAbsent(key, { framework, model?, updatedBy })` that, under the existing
  per-topic lock, writes `{ current, previous: null }` ONLY if `get(key) === null` (no entry at all —
  a husk blocks it) and returns `seeded | present`. This is the first lock-serialized `system:` seed
  (legacy-seed assigns directly, `TopicProfileStore.ts:723-729`). `updatedBy` is
  `system:dashboard-create` (explicit pick) or `system:new-topic-default` (no pick, default set). No
  application arm, no respawn, no carrier cancel: the spawn that follows resolves the pin like any
  other pin. The model axis follows the regime: written live only under `fully-live`; otherwise
  DROPPED (never shadowed) and audited as `model-not-applied:<regime>`. The framework axis is live in
  every regime (parity with pins; a seed always carries a framework, so the fleet's model-only
  refusal never applies). Undo semantics, accepted rather than extended: a seed has
  `previous: null`, so operator undo answers `nothing-to-undo` (as for legacy-seed); the seed is
  removed only by the bound operator's `clear` (or replaced by their next pin).
- **Disclosure:** the seed is not invisible. When the helper returns `seeded`, exactly ONE fixed
  line is posted into the new topic via `sendToTopic`, naming ONLY the axes actually written ("This
  topic starts on Codex · Sol — chosen at creation" under `fully-live`; "This topic starts on Codex
  — chosen at creation (model not applied on this install)" when the model axis was dropped), and
  the seed is audited to `logs/topic-profile-changes.jsonl`. The line is sent with
  `sendDeterministicTelegramNotice(telegram, <producer>, …)` exactly as the inbound lifecycle line is
  (`server.ts:3053`), with a new producer id `topic-profile-creation-seed` added to the closed union
  at `OriginDeterministicSend.ts:7-9` — so the origin record says "fixed template, no model" (a raw
  `telegram.sendToTopic` with no producer scope would be dispatched via `runAsUnboundAutomation`,
  `OriginBotEgress.ts:128`, and recorded as `legacy-unattributed`); no hand-written footer. A held
  or slow send never blocks the create. It is fire-and-forget and may be held or lost by the outbound layer; the audit row is the
  durable record, the line is the courtesy.
  Topic participants seeing the door/model
  is intended: the parent spec already discloses every profile change into the topic
  (`topicProfileWriteSurface.ts:386-390`), and a topic's door is not a secret — the operator's quota
  is. The disclosure line is the in-topic record of the seed, whichever dashboard action caused it.
- Because a seed is a pin, it beats `topicProfiles.defaults` / `topicFrameworks` for that topic —
  the dashboard default is a *starting pin*, not a fallback layer. The control is NAMED for what it
  does everywhere it appears (header, sheet, modal hint): **"Default for dashboard-created topics"**
  — never "default for new topics", which reads as global. Required UI copy in the sheet (not only
  spec prose): "Applies to topics you create from this dashboard. Topics you start in Telegram and
  topics that already exist are not changed."

### 3.3 New topic with a chosen door + model (`POST /sessions/create`)

Accepts optional `framework` and `model`. When either is present the request must carry
`X-Instar-Request: 1` (403 otherwise — parity with the other profile writes; Bearer only, no
operator-session step, per the operator decision recorded in §3.2), and `platform` must be
`telegram` (or `auto` resolving to Telegram): `headless` or `slack` with a preference → 400 (no
topic key / out of v1 scope). An explicit pick on a topic with no bound operator yet is a write the
generic route would refuse (`no-bound-operator`); it is admitted HERE, and only here, because the
handler created the topic in the same request — that is the named new write path of §3.3, audited
with `system:dashboard-create`. A no-preference create is unchanged; if a default is set it is
seeded with `system:new-topic-default`. Flow — a small SAGA with compensations, named as such so the invariants are explicit: **the seed,
once written, is retained (never compensated); the placement is compensated by `release`; the
Telegram topic is never deleted (it is the operator's); every exit names the step it reached.**

1. Validate per §3.5 BEFORE creating anything (400 with the validator's reason).
2. Create the Telegram topic. If `findOrCreateForumTopic` REUSED an existing topic → 409
   `topic-exists` when a preference was given ("switch it from its session view"); with no preference
   the reuse proceeds as today and is never seeded. If creation FAILS with a preference → 502, no
   headless fallback, no spawn (the silent headless fallback stays only for the no-preference request).
2b. **Pool ownership (only when the topic was CREATED, never on reuse).** Ordering detail: the seam
   is CALLED before step 2 (its `dark` / `not-authoritative` answer needs no topic id), so a 409
   creates nothing; its `place` runs after step 2, on the new id, and RE-EVALUATES the lease leg at
   that moment — if the lease moved in between, `place` answers `not-authoritative` and the response
   says the Telegram topic already exists (it is the operator's; never deleted) and names the holder
   to finish on. Today the handler places no ownership record
   (`routes.ts:11362-11420`: no `casClaimOwnership` / router call), so on a pool the topic's FIRST
   inbound message hits `SessionRouter.route()` with no record → `placeAndClaim(msg,'new')` →
   load-balanced placement that may land on machine B, where the predicate would seed B's default
   and A's spawned session becomes a duplicate — the operator's explicit choice silently lost. A bare
   `ctx.sessionOwnershipRegistry.cas({type:'place'})` from routes would NOT fix it: `cas`
   (`SessionOwnershipRegistry.ts:182`) writes the LOCAL store only and does not journal; peers learn
   ownership solely through `emitPlacement` → the coherence journal → OwnershipApplier, and
   `emitPlacement` (`server.ts:22568`) plus `routerNonce` are closures inside `startServer`;
   `_confirmLocalSessionPoolClaim` (`:611`, assigned `:24533`) is not on the routes ctx either
   (`:26870` passes only `sessionOwnershipRegistry` + `meshSelfId`). Fix: ONE seam on ctx, passed as
   a thunk because it is assigned inside the pool-activation block —
   `sessionPoolLocalClaim?: () => { kind: 'dark' } | { kind: 'not-authoritative', holderMachineId, holderNickname } | { kind: 'ready', place(sessionKey): { ok, reason }, confirm(sessionKey): boolean, release(sessionKey): boolean }`
   — consumed by the route through ONE service-level operation, `claimDashboardCreatedTopic(sessionKey)`
   / `settleDashboardCreatedTopic(sessionKey, outcome)`, whose implementation owns the CAS, the
   journal emit, the nonce, confirm and release; the route never sees pool internals (the predicate
   and nonce details below are the SERVICE's contract, recorded here so it is reviewable, not the
   route's).
   — built next to `:24533`. The thunk evaluates its predicate AT CALL TIME and answers `dark` when
   the router is not live (single-machine — the create proceeds with the seed exactly as today),
   `not-authoritative` (naming the holder) when router-live but replication is off or this machine
   is not the holder, and `ready` only when ALL of: router-live (`_sessionRouter && _sessionPoolStage() !== 'dark'`, `server.ts:2689`),
   placement replication ON (`_replicationOn`, `server.ts:22062`, from `isPlacementReplicationEnabled(config)` = `multiMachine.coherenceJournal.replication.enabled === true`, hoisted so the seam can read it), and THIS machine holds the lease
   (`_holdsLeaseForSpawn` is NULLABLE, `server.ts:661`, set only inside the coordinator block
   `:5826`; router-live with no lease coordinator is reachable, since the router is built under
   `:21552` without one: that case answers `{ kind: 'not-authoritative', holderMachineId: null }`
   — NEVER the `:685` `? … : true` fallback, which is the fail-open-write inversion this step avoids;
   unit-tested as its own case). `_replicationOn` is a boot-time `const` (already in scope at
   `:25021`; a config edit needs a restart), so "evaluated at call time" holds for the router-live
   and lease legs and is a boot snapshot for the replication leg — stated, since Echo has it on. Why all three: `cas` writes the LOCAL store and
   peers learn placement only through the replicated journal → OwnershipApplier
   (`durableOwnershipActivation.ts:25-27`); the router that answers the first inbound runs on the
   lease/ingress holder (`server.ts:2713`, single-router topology `SessionRouter.ts:185`). A place
   made on a non-holder with replication off never reaches the authoritative registry, so the first
   message would be load-balanced anyway — the duplicate 2b exists to prevent — and with no record
   on the holder there is no `prevOwner`, so the carrier never stages a pull and the pin is lost.
   On `not-authoritative`, EVERY create is refused `409 placement-not-authoritative-here` naming
   the holder (the write-admission refusal pattern) — with or without a preference. Today a create
   on a non-holder spawns a session locally with no ownership record at all (an ownership-gated
   side effect performed off-owner); this spec closes that rather than preserving it, because the
   modal can simply say which machine to create from. On `dark` (single-machine) the create
   proceeds exactly as today, with the seed. The handler never has to guess which case it is in (a bare `null` could not
   tell "dark" from "not authoritative"). Router-live predicate detail: the router
   object itself is constructed for every agent with a mesh identity (`:24550` under `:21552`, no
   stage gate) and `_sessionPoolStage` is reassigned later (`:25704`), so "built inside the block"
   would exist on every pool-dark mesh-identity agent — the fail-open-read / fail-closed-write
   inversion this step must avoid (`routes.ts:3438` is a fail-OPEN read gate; reusing it for a write
   would 409 creates on a pool-dark agent). Wraps CAS `{type:'place', machineId: self}` + `emitPlacement` +
   the SAME `routerNonce` counter (`${meshSelfId}:c:${++routerNonce}`; `cas` records per-session
   nonces, `SessionOwnershipRegistry.ts:192`) for `place`; the existing confirm closure
   (`confirmLocalPlacementAfterDelivery`, `SessionPoolLocalClaim.ts:31`, claims only a self-owned
   `placing` record); and `release` = confirm-if-placing → `cas({type:'release', machineId: self})`
   → `emitPlacement(sk, r, 'released', prev)` — the exact pattern already at `server.ts:22771`
   (release from `placing` is refused, `SessionOwnership.ts:171` `release-requires-active`, hence the
   confirm first). No `cas` is ever called from routes: `scripts/lint-cas-emit-placement.js:40` fails
   CI on any `sessionOwnershipRegistry.cas(` site without an `emitPlacement` pairing. The
   handler calls ONLY the seam (its `confirm` is idempotent), and ONLY when `reused === false`.
   `/sessions/create` is not an `admitLocalSpawn` callsite (`server.ts:2811` is Telegram-only), so
   no SpawnAdmission provenance/ladder row is written for a dashboard create — the seam's self-place
   is the admission record, stated so nobody looks for a ladder row that does not exist (a reused topic already has an
   owner — `place` refuses any non-released record including self-owned `active`,
   `SessionOwnership.ts:113` — so the reuse path places nothing, as today): `place` before seeding,
   `confirm` (`placing → active`) after the spawn. A refused place on a freshly created topic
   (a same-id race) → 409 `topic-owned-elsewhere`, no seed, no spawn. Absent seam (single-machine, or
   pool dark) → unchanged. This makes the first message route to
   the creating machine, keeps the carrier and the epoch floor coherent, and makes step 7's "next
   inbound message cold-spawns it onto that pin" true on a pool.
   **Rejected alternatives, so the seam is not mistaken for the only idea considered:**
   *Proxy the create to the holder over the mesh* — adds a new mesh RPC surface (create topic,
   seed, spawn, register on a peer) with its own auth, timeouts and partial-failure states, for a
   button the operator can tap on the holder's own dashboard; heavier than the seam and a new
   failure class. *Holder-only API (refuse everywhere else)* — that IS what `not-authoritative`
   does; the seam adds only the `ready` path so the holder's create places ownership correctly
   instead of spawning off-record as today. *Do nothing on a pool* — today's behavior, which spawns
   with no ownership record and lets the first message land elsewhere (the duplicate 2b prevents).
   **The contract at a glance (the normative table; the prose above is the evidence):**

   | Seam answer | Route response | Ownership action | Seed / spawn | Compensation |
   |---|---|---|---|---|
   | `dark` (single-machine) | proceed | none | seed (if pick or default) → spawn → register | seed retained on failure; 500 names the step |
   | `not-authoritative` | 409 naming the holder — evaluated BEFORE step 2, so no Telegram topic is created | none | none | none |
   | `ready`, place ok | proceed | `place` (self, journaled) | seed → spawn → register → `confirm` | spawn threw ⇒ `release`; spawn returned but register failed ⇒ `confirm` + report |
   | `ready`, place refused | 409 `topic-owned-elsewhere` | none | none | none |

3. Seed via `mutateIfAbsent` with `system:dashboard-create` (explicit preference) or
   `system:new-topic-default` (no preference, default set); with neither, no seed. Post the §3.2
   disclosure line.
4. **Spawn through the ONE chokepoint:** `server.ts` exposes `spawnSessionForTopic` on the routes
   ctx as a thunk and the handler calls it (no initial message) instead of `spawnInteractiveSession`
   directly. What the chokepoint actually does (verified, not assumed): resolves the profile
   (`:1248`, so the just-seeded pin is honored on the FIRST launch — the original defect), records
   `recordSpawnSuccess` for the §10.4 breaker + the codex same-cwd fence (`:1384-1387`), applies
   `_topicLocalModelStore` precedence, writes the Codex identity file for a Codex pin, and delivers
   fallback notices. What it does NOT do: the G3 lease gate (`g3ShouldSpawnLocally`, `:680`) and
   `admitLocalSpawn` (`:2811`) are called by the Telegram callsite BEFORE it (`:3018-3028`), not
   inside it — so a dashboard create runs with NO lease gate and NO admission row; §3.3 2b's
   self-place IS its admission on a pool, and on a single machine there is nothing to gate. The
   `accountSwap` argument is a caller-supplied passthrough (`:1048`; the only resolver lives in the
   SessionRefresh respawner, `:19571-19586`) — the dashboard create passes none. This is what
   makes §3.5's "a door that then cannot launch trips the existing breaker + fallback notice" TRUE
   for dashboard creates; a bare `spawnInteractiveSession` would have made it a 500 with no
   bookkeeping, and it would silently skip `_topicLocalModelStore` precedence (`:1340-1351`),
   `ensureFrameworkIdentityFile` for a Codex pin (`:1326-1334`) and fallback-notice delivery
   (`:1259-1266`) — the two-readers pattern the chokepoint's own ROUND-21 comment (`:1249-1255`)
   deleted. Occam: one spawn path, not a second orchestrator. Facts for the implementer: the
   signature is `spawnSessionForTopic(sessionManager, telegram, name, topicId)` (`:1036-1052`) and
   it is callable for a topic with no session and no inbound message — `latestMessage` omitted
   becomes "Session started — send a message to continue." (`:1053-1054`), a fresh topic has empty
   history, and `resumeSessionId` is `undefined` from `_topicResumeMap` (`:1306`). It does NOT
   register the binding (its callers do, `:3051`, `:27592-27604`), so step 5 is not a duplicate.
   Seat, checked against BOTH scope and time: `wireTelegramRouting` is a module-scope export
   (`:2354`) called at `:7889`, while `_topicProfileCtx` is a `startServer` local created at
   `:26241` — so neither site can see the other's locals. The thunk is therefore built in
   `startServer` AT ctx construction (`:26241`) from `telegram` and `sessionManager` (both
   `startServer` locals, the same ones passed to routing at `:7889`) and the late-bound module ref
   `_spawningTopicsRegistryRef` (`:580`, assigned inside `wireTelegramRouting` at `:2399-2400` — the
   existing pattern for exactly this, `:577-580`), and seated as `spawnForTopic`. That ref is
   `null` when Telegram routing never wired — which IS the 409 `telegram-routing-not-wired`
   condition, so the null case is the refusal, not a gap. (The chokepoint itself is module-scope
   and needs no closure.) **Silent start, by construction:**
   with no message and no history the chokepoint today builds `[telegram:N] Session started — send a
   message to continue.` + the relay block and injects it as a user turn (`:1053-1054`,
   `:1236-1290`; the HANDOFF-ONLY branch at `:1210` needs context to apply), and the session would
   likely post an unsolicited greeting on top of the disclosure line. Today's raw path injects
   nothing (`routes.ts:11402-11406`, `SessionManager.ts:5740`). The chokepoint therefore gains a
   `silentStart` option (dashboard create passes it through the existing `spawnOpts` bag, `:1051`,
   never a new positional): it short-circuits BEFORE the bootstrap build at
   `:1236` (so the temp-file write at `:1273-1280` and the relay-block append at `:1287-1293` never
   run — no orphan file) and passes `undefined` as the initial message at `:1357`, exactly what the
   raw path does today (`routes.ts:11402`). The session comes up idle with its normal session-start
   hooks; a Codex session gets the relay convention from the AGENTS.md appendix
   (`ensureFrameworkIdentityFile`, `appendTelegramRelayBlock: true`, `:1321-1331`) since the inline
   block is dropped by design; the only message in the new topic is the disclosure line. The G1
   cold-start fallback notice lives in the inbound callsite's `.catch` (`:3064-3086`), not the
   chokepoint — a failed dashboard create surfaces through the HTTP error instead, with topic and seed
   intact for step 7. The thunk ALSO arms `spawningTopics` around the spawn — `has()` then `add()` with NO await
   between them (the inbound path is synchronous there, `:3013`→`:3040`; `add()` overwrites with a
   newer token and never refuses a duplicate, so `has()` is the only guard): a key already mid-spawn
   (an inbound message beat the dashboard) ⇒ 409 `topic-spawning`, never a second session; before
   `has()` it also mirrors the inbound "no session mapped" gate (`:3010`) — a topic that already has
   a registered session ⇒ 409 `topic-has-session`. On a pool, either 409 with a `placing` record
   from 2b means a local spawn IS underway, so the handler `confirm`s (never releases) and the seed
   stays as written: the in-flight spawn honors it if the seed landed before its resolve, otherwise
   that first session runs on the default door and the response says so — see step 5. Telegram only: the Slack/headless branches never
   reach the chokepoint (it needs the adapter).
5. Register the session through the adapter — `telegram.registerTopicSession(topicId, session, name)`
   as the Telegram inbound callsite does (`server.ts:3051`); ordering seed (3) → spawn (4) → register
   (5) is deliberate: on a single machine an inbound message arriving between topic creation and the
   seed would cold-spawn on defaults, so the seed lands before anything can spawn. The ctx thunk
   (reaching the `spawningTopics` const through `_spawningTopicsRegistryRef`) arms it (`:2399`,
   today armed only by the inbound path) from the moment it is called until the binding is
   registered — the thunk performs spawn AND `registerTopicSession` under ONE token (it takes the
   register step as part of its contract; a thunk that returned between the two would leave a
   millisecond unguarded window), cleared in `finally` with its own token (the guard has no sweep — a hung entry is surfaced, never
   auto-cleared). What the guard does with a message in that window — stated honestly, chosen
   deliberately for v1: the inbound path posts "Session is still starting up — please wait a
   moment." and RETURNS (`:3013-3017`); the message is NOT queued or replayed, so an operator who
   types into a topic seconds after creating it may have to resend. That is today's behavior for any
   topic mid-spawn and beats the alternative (a second session on the same machine). Routing the
   collision into the pending-inject path is a follow-up, not v1 — and DELETE the raw `writeFileSync` of the
   registry (§2: it is clobbered by the adapter's next save and would let a re-created topic look
   never-spawned).
6. The 201 body reports `profile: { framework, model, source }` as the resolver returned it plus any
   fallback notice — never an echo of the request.
7. Failure after the seed (spawn or registration throws): the seed is deliberately NOT rolled back —
   the topic exists in Telegram with the chosen starting pin, and the next inbound message spawns
   it onto that pin through the normal inbound path (which resolves the pin like any other).
   On a pool the handler must not leave the record `placing`: with the inbound queue live the router
   custodies every message for a `placing` record (`SessionRouter.ts:296-300`,
   `ownership-contention`) and would strand the topic with its first message queued forever; with the
   queue dark the message falls through to local dispatch (`:2767-2775`) and hits the guard's notice
   — either way the record must be settled. On a failure after 2b where NO session was returned
   (spawn threw) the handler calls the seam's `release` (confirm-if-placing → release → journal
   emit) so the next message is placed normally by the router. If the spawn RETURNED a session and
   a later step failed (adapter registration), the handler CONFIRMS instead — the session is alive
   on this machine, so releasing would let the router re-place the first message elsewhere and
   create the very duplicate 2b prevents — and reports the registration failure in the response
   (the live session still answers; the binding is repaired by the normal inbound path's
   `registerTopicSession` on the first message). **Honest limit, not a proof:** whether the retained pin then FOLLOWS the topic to
   whichever machine the router picks depends on the carrier seeing this machine as the previous
   owner of a released record; that is not proven here. The 500 response therefore says the pin was
   retained on THIS machine and tells the operator to confirm the door from the session view after
   the topic's first message; the §5 pool test asserts the observable contract (500 names the step;
   record is `released`; a later message is answered on some machine; the operator can set the door
   there), not the carrier hop. If the SEED itself throws (before spawn) the handler returns 500 and
   the topic is left unseeded — its next inbound would run on defaults, not the explicit choice; the
   response says so and tells the operator to set the door from the session view after the topic's first message. The response always names the failed step
   and whether the pin was retained.

Why the seed path and not the write surface: the topic has no bound operator yet (nobody has
messaged it), so a token write is refused by design (Know Your Principal). The seed carries the
`system:dashboard-create` attribution instead of inventing a principal and grants nothing: switching
or clearing that topic LATER still requires the bound operator (§3.4). This is a NEW write path,
stated as such: reachable only from the create handler for the topic it just created in the same
request, never from the generic `/topic-profile/:id` route or any inbound path.

### 3.4 Switching an existing topic

Unchanged route: `POST /topic-profile/:topicId` (token principal, requires bound operator). The
dashboard adds no policy: the sheet shows the server's reply verbatim, including `no-bound-operator`
("this topic gets an operator the first time you message it") and the existing
`cooldown-confirm-required` / switch-now confirm, with a "Switch anyway" that re-sends with the
confirm the surface already defines. A framework switch = respawn with the conversation preserved;
the sheet says so before the tap.

### 3.5 One validation rule for every dashboard write

The ONE canonical write predicate: `validateProfileFields` (enum + billing lane) **plus**
`enabledFrameworks` membership when set **plus** `availability !== "unavailable"` — so `verified`
AND `assumed` pass, `unavailable` is REFUSED by validation (not merely disabled in the UI). Applied
identically by the options route (`selectable`), `/sessions/create` step 1, and `new-topic-default`.
Because `assumed` passes, a door with an unreadable probe is offered as "(not verified)"; if it then
cannot launch, the existing spawn-failure breaker + fallback notice apply (parent §3.5) — same as a
conversational pin today. **Scope, stated as policy:** the `unavailable` refusal applies to the three
DASHBOARD writes only. Conversational and `/topic-profile/:id` API pins keep today's behavior
(validate the enum, fail open on launchability, fall back with a notice at spawn) — nothing
backward-incompatible for existing callers. The dashboard is stricter because it can SHOW the reason
instead of letting the operator discover it at the next spawn. This is an INTENTIONAL UX/API
divergence — the same pair can be accepted in chat and refused in the dashboard — carried as a
machine-readable refusal (`code: "dashboard-unavailable-door"`, `chatPinAllowed: true`, tested so a
client cannot collapse it into generic invalid input) and the refusal copy says why ("Codex isn't installed on this machine — you can still pin it in chat and it will
fall back with a notice"), so it never reads as stale dashboard data.
- **One creation service:** `seedTopicProfileAtCreation(topicKey, source: 'dashboard-create' |
  'new-topic-default', explicit?)` (§3.5 validation INSIDE the service — `store.mutate` checks only
  tier/model exclusion, `TopicProfileStore.ts:365`, and #2085 will reuse this service without the
  route's step 1 — → `mutateIfAbsent` → regime filter → audit → disclosure line) is the only seeding
  code; `/sessions/create` owns what is unique to it (topic creation, pool
  placement, spawn with the resolved profile, adapter registration). When Telegram seeding lands
  (#2085) it calls the same service.
- **No newness inference in v1:** the only eligibility check is `store.get(key) === null` inside
  `mutateIfAbsent` on a topic the handler just created (or, on reuse, refused/unseeded per §3.3).

### 3.6 Dashboard UI (Sessions tab only)

- **New Session modal:** on `409 placement-not-authoritative-here` the modal says "New topics are
  placed by <holder nickname> right now — open that machine's dashboard to create this one." Door and Model selects under Platform (Model filtered to the door, with an
  "Account default" entry; preselected from `newTopicDefault`, then `defaultModel`). Disabled for
  Headless and Slack. Unavailable doors disabled with their reason. A one-line regime note when
  `regime !== 'fully-live'`. When the picked pair differs from the new-topic default, the Create
  button reads "Create on Codex · Sol" (the choice is final until the topic's first message, §6) so
  a mistaken pick is caught at the tap rather than discovered later.
- **Session view header:** a "Door + model" button beside the model badge → sheet with the current
  resolved door/model and source ("pinned by you", "seeded at creation", "default"), the two selects,
  "Switch". Shown for local Telegram tiles; remote tiles and Slack tiles show the read-only badge
  (§6). After a switch the badge shows "switching…" until `GET /sessions` reports the launched
  `model` — never an echo of the selection. While touching the badge, `session.model` at
  `index.html:4583` is escaped (it is closed-enum today, but the spec must not claim "never
  innerHTML" over an unescaped line).
- **Sessions list header:** "Default for dashboard-created topics: Claude Code · Opus 5.5 ▸" with the replication
  note from `newTopicDefault.replication` ("this machine only" in v1). Inside the sheet the same
  caveat sits directly above the Save control: "Applies to new topics created on <nickname>. Your
  other machines keep their own default until replication lands. Topics you start in Telegram are
  not covered yet (coming with the cross-machine work)." The sheet shows the audit count of seeds
  made from this default since boot ("4 dashboard topics started on this default"). Acceptance
  criterion for graduation (Maturation plan): on Echo, every dashboard-created topic during the soak
  week got its chosen or default door, verified from `GET /sessions`. Tapping opens the same sheet;
  saving is a plain `fetch` with the dashboard's normal Bearer session PLUS an explicit
  `'X-Instar-Request': '1'` header (the file-save pattern at `index.html:7036-7041`; neither the
  existing create call at `:4991-4997` nor the shared `apiFetch` at `:5674-5679` sends it, and the
  `:9814` helper is the origins panel's private wrapper — without the header both new writes would
  403). All THREE new dashboard fetches send it: the default sheet's save, the New Session
  modal's create, and the switch sheet's `POST /topic-profile/:id` (there is no `topic-profile`
  fetch in the dashboard today). No PIN step (operator decision,
  §3.2).
- Every server-supplied string (door, model, source, message, reason) is rendered with
  `textContent`.
- Mobile-first: native `<select>`, full width at phone width, no horizontal scroll.

## 4. Safety / side effects

- Two new write paths, both named: the new-topic default (Bearer, same trust as every other
  profile write), and the creation-time seed
  (`system:new-topic-default` / `system:dashboard-create`). Neither reaches the application arm,
  neither respawns; each seed posts one fixed disclosure line and is audited. A seed can only ever
  set a pin on a topic with no entry at all, atomically.
- The generic switch/clear path is unchanged and keeps its bound-operator floor. Consequence, stated:
  a dashboard-created topic that has never been messaged cannot be switched or cleared from the
  sheet until it is messaged (the sheet shows the server's refusal).
- Model choice affects subscription quota draw (Fable vs Opus vs Astra). Every write here is
  audited with its principal; none is PIN-gated — the operator ruled (2026-09-27) that a PIN adds no
  safety over the Bearer token the dashboard already holds, which can switch any bound topic onto
  any door today. Stated so a future reviewer does not re-add the gate as a "fix".
- Rollback: `{clear:true}` on the default stops future seeds (no other flag — a `seedNewTopics`
  switch would add a lever whose flip is NOT cheap after the fact, since seeded pins persist).
  Already-seeded topics keep their pins (partial rollback, stated); they are identifiable by
  `updatedBy: system:new-topic-default|system:dashboard-create` and cleared per topic with the
  existing `clear` once the topic has a bound operator. The UI is additive.

## 5. Tests (all three tiers)

- Unit: options derivation (enabled ∩ supported, deny-set subtraction, null-model option, empty pi
  list, fail-open availability); `mutateIfAbsent` atomicity, `present` on any existing entry including
  a `current: null` husk; regime filter on the seed's model axis (dropped + audited, never shadowed);
  `mutateIfAbsent` refuses a second seed on the same key (`present`) so a double-submitted create
  cannot re-seed; validation parity (every `selectable` option
  passes the write check, every non-selectable one is refused).
- Integration: `GET /topic-profile/options`; `new-topic-default` (Bearer + intent header → 200;
  missing intent header → 403; invalid model → 400; clear; audit row; NO attention item); `/sessions/create` with a preference
  (pin seeded before spawn and spawn options carry the resolved profile; disclosure line sent; on a
  pool the seam's `place` runs before the seed and `confirm` after the spawn, including on the
  spawn-failure path; refused place → 409 with no seed; non-holder or replication-off pool →
  409 `placement-not-authoritative-here` naming the holder, with or without a preference;
  reused topic → 409; Telegram failure → 502 with no spawn; headless/slack + preference → 400; missing
  intent header → 403; adapter `registerTopicSession` called, no raw registry write); the intentional
  divergence: the SAME `{framework, model}` with `availability: "unavailable"` is accepted by
  `POST /topic-profile/:id` (fallback notice at spawn) and refused by the three dashboard writes with
  the exact copy from §3.5 — asserted so a maintainer cannot "fix" the mismatch by accident; no default + no
  preference ⇒ spawn options byte-identical to today; unlaunchable door selected ⇒ fallback notice.
- E2E (production init path): options route 200; a topic created with `codex-cli` launches with the
  codex framework in `GET /sessions`; a dashboard create with no pick and a default set launches on the
  default; a pre-existing unpinned topic — including one whose session was reaped and the server
  restarted — does NOT change when the default is set or changed; a Telegram-created topic (single
  machine or pool) launches on the global defaults exactly as today with NO seed and NO audit row
  (byte-identical spawn options). Pool (two-server harness): a dashboard-created topic is placed on
  the creating machine, its first message routes there, and no second seed occurs on the peer; any
  create on the non-holder is refused naming the holder; the spawn-failure path leaves the
  record `released`, the 500 names the step, and a later message is answered on some machine.
- Live-User-Channel proof: a user-role drive of the real dashboard at phone width — create a topic
  on codex, switch a live topic, set the default — recorded before the operator is asked to try it;
  it explicitly asserts "modal create with a preference from the real dashboard → 201, not 403" (the
  intent header is sent).
- Agent awareness: CLAUDE.md template Topic Profile section gains one line about the Sessions-tab
  controls with its OWN sniff string in `migrateClaudeMd` (`PostUpdateMigrator.ts:10529` sniffs the
  section header only and would skip an appended line).

## 6. Named limitations (v1)

- Slack / WhatsApp / iMessage: core topic profiles resolve on Slack keys (parent ELI16), but their
  SPAWN paths bypass the resolver today, so no default and no dashboard switch for them in v1
  (read-only badge). Compatibility note: the parent's "works on Slack too" describes the pin store,
  not this dashboard surface.
- Remote (other-machine) tiles: read-only badge; switch from that machine's dashboard or in chat.
- Thinking depth / effort: not in the v1 sheet (API supports them; additive later).
- Fleet: `topicProfiles` is dev-gated → regime `disabled` on the fleet: door switch works, model
  refused, and the UI says so.
- Never-messaged dashboard-created topics cannot be switched/cleared until first messaged — accepted
  UX debt for v1 ("I just created this with the wrong model" waits for one message in the topic; on
  a pool, that message also settles ownership). This is said IN the create flow, not only here: the New Session modal's Door/Model hint reads "You can
  change this again after the topic's first message", and the 201 response carries
  `switchableAfterFirstMessage: true`. No narrow pre-message switch route is added (Occam: one
  message in the topic binds the operator and unlocks the ordinary route).
- The new-topic default is machine-local in v1 (§7).
- **Named hold — topics created directly in Telegram do not get the default in v1 (any machine).**
  They run on the global defaults exactly as today; nothing is written, nothing is audited (there is
  nothing to audit — the code path is unchanged). The default sheet says so in plain words. The
  design for it — the topic-ownership record as the sole newness signal on a pool, the durable
  known-topics ledger on a single machine, and the replicated default — is tracked in #2085 with
  expiry 2027-03-25 (issue re-scoped to this exact contract on 2026-09-27), and is proven on Echo
  (a pool) before it ships, which the v1 single-machine variant could not be.

## 7. Multi-machine posture

Plain summary first: **pins move with their topic; the default is per-machine in v1; the options
list is whatever this machine has installed.** The constitution's posture words used below:
`unified` = same state on every machine of the agent; `machine-local` + a justification key = state
that stays on one machine for a stated reason; `migrating-to-unified` = machine-local now with a
dated, tracked path to unified; `proxied-on-read` = operational (not memory) state read live from
each machine; `memory-bearing` = something the agent must not lose if a machine disappears.

- **Topic pins** (seeded or switched): `unified` — ordinary topic-profile entries that ride the
  existing TopicProfileTransferCarrier with the topic. The only seeds in v1 are dashboard-create
  seeds on a topic the handler just created (and, on a pool, placed on itself), so no seed can ever
  land on a topic that lived elsewhere. One qualified case, matching §3.3 step 7: after a dashboard
  create whose spawn threw on a pool, the placement is released and whether the retained seed then
  rides the carrier to the machine the router picks next is NOT proven — the operator is told to
  confirm the door from the session view; the pin is `unified` in every other path.
- **New-topic default record**: operator preference (memory-bearing), destination `unified`.
  v1 ships it machine-local with the honest `replication: "local-only"` label on the surface.
  machine-local-justification: migrating-to-unified ratified=5a4efecc1 tracking=https://github.com/JKHeadley/instar/issues/2085 since=2026-09-27 expires=2027-03-25
  (`ratified` = the commit that ratified Amendment 1 of "An Instar Agent Is Always a Multi-Machine
  Entity" — operator directive, topic 52222, 2026-08-22 — establishing `unified` as the destination
  for memory-bearing state; `tracking` = the follow-up issue.) The full destination design (lean WS2 record kind under
  `multiMachine.stateSync.newTopicDefault`, singleton key, HLC-highest among PEER records, tombstone
  on clear, peer-default-only authority with local-wins and revalidate-on-fold, Bearer write per writing
  machine) is recorded in issue #2085, NOT here, so it cannot be mistaken for v1 scope; the v1
  contract is only the `local-only` label. `replication` reports `mesh` once that lands.
- **Options route**: OPERATIONAL state, not memory-bearing — a live probe of which door CLIs are
  installed and admissible on THIS machine's disk, cached seconds, never persisted. Posture:
  `proxied-on-read` (the constitution's valid posture for operational state). v1 has NO remote read
  (remote tiles are read-only, §6); the posture is declared for the tracked follow-up, whose named
  merged read is the existing `?scope=pool` fan-out pattern, each machine answering for its own disk. It is deliberately NOT keyed `hardware-bound-resource`:
  DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC §(432) already ruled that installed CLIs are not bound to
  specific physical hardware, and this spec follows that ruling rather than re-labelling the same
  surface class.

## Maturation plan

- **test-agent-live:** the options route, `mutateIfAbsent`, the new-topic predicate and the
  `/sessions/create` changes are unit/integration-testable on a throwaway agent from the first build.
- **dev-agent-live:** live on Echo (regime already `fully-live`), verified by the phone-width
  user-role drive of all three controls; the default's audit row and the seed disclosure line observed.
- **fleet:** with the release; the UI and routes are additive and the fleet regime is `disabled`
  (door switch works, model refused, stated on screen) until topic profiles graduate.
- **graduation criterion:** one week on Echo with zero operator-found escapes across the three
  controls, evidenced from live state — every dashboard-created topic in the week shows its chosen
  or default door in `GET /sessions` and has its seed audit row, and no pre-existing topic's pin
  changed (`logs/topic-profile-changes.jsonl` carries no non-operator write on an old key).
- **dark-window:** none for this surface (it is additive); the held items are pool Telegram seeding and
  the replicated default, both tracked in issue #2085 with the same expiry.

## Decision points touched

| # | Decision point | Class (invariant / judgment-candidate) | Notes |
|---|---|---|---|
| 1 | Which doors/models the options route offers | invariant | Derived by running each candidate through the write check (§3.5); no competing signals. |
| 2 | Validation of a dashboard-chosen framework/model | invariant | `validateProfileFields` + enabled check + `admissibility`, identical on every write path. |
| 3 | Confirm before switching a live topic | invariant | The existing write surface's refusal/confirm contract; the dashboard adds no policy. |
| 4 | Is a dashboard-created topic eligible for a seed | invariant | `mutateIfAbsent` on `store.get(key) === null` for the topic the handler just created; reuse ⇒ no seed (409 with a preference). Telegram-created topics: no evaluation in v1 (hold, #2085). |
| 5 | Model axis of a seed under a non-live regime | invariant | Same regime table pins obey; dropped + audited, never shadow-applied. |
| 6 | Who may change the new-topic default | invariant | Bearer + intent header, same as every profile write (operator decision 2026-09-27: no PIN). |
| 7 | Whether a received peer default applies (follow-up #2085 — NOT v1) | invariant | Applies only with no local record/tombstone; local wins. Recorded so the follow-up inherits the classification; nothing to build here. |
| 8 | Pool placement on dashboard create (§3.3 2b) | invariant | Failure after a spawn that RETURNED ⇒ confirm + report (never release a live session's record); Seam `dark` ⇒ seed+spawn as today (single-machine); `not-authoritative` ⇒ every create 409 naming the holder (no off-owner spawn); `ready`: `reused` ⇒ skip; created + place ok ⇒ seed+spawn+confirm; created + place refused ⇒ 409, no seed; failure after place ⇒ seam `release` (confirm-if-placing, then release, journaled). |
| 9 | Inbound message while a dashboard create is mid-spawn | invariant | Note: "the seed lands before anything can spawn" is a TIMING argument (seed precedes the thunk arming the guard; only the inbound poll could spawn earlier), not a construction guarantee — the 409s above are the construction guarantee. Guard armed ⇒ "still starting up" notice and the message is dropped on a single machine / with the inbound queue dark (today's mid-spawn behavior); on a pool with `sessionPool.inboundQueue` live the router queues it under `ownership-contention` (`SessionRouter.ts:298`) and replays it after step 5's confirm (`:22579`). Never a second session. |

## Verification declarations (P20)

- **`availability`**: symbol = the tri-state from `admissibility(fw)` (binary presence + framework
  opt-ins); state claimed = "a spawn on this door can launch here". Unmeasurable (probe errored,
  nothing to check) = `assumed`, preserved as its own value — never collapsed into `verified`, never
  a fabricated `unavailable`; the write path keeps the resolver's fail-open behavior unchanged.
  Corroboration = the spawn path uses the SAME function, and a launch that still fails trips the
  existing spawn-failure breaker + fallback notice, which the dashboard then shows.
- **Badge after a switch**: symbol = `GET /sessions` `model`/`framework` of the LAUNCHED session;
  state = the topic runs on the chosen pair. Corroboration = the write surface's `appliedLive` and
  the reap-log entry for the respawn. Until the new session is listed the badge shows "switching…",
  never the selection.
- **"This topic has no pin yet"** (the only eligibility claim in v1): symbol = `store.get(key) ===
  null` under the store lock; state = no pin, seed, or husk exists for a topic the handler created
  in this request. Corroboration = the topic id was minted by `findOrCreateForumTopic` with
  `reused: false` moments earlier (a reused id is refused before the check). Unmeasurable (store
  read throws) = 500 before spawn, no seed, stated in the response.
- **`replication`**: v1 constant `local-only` — a literal, never a measurement. In the destination
  design: `mesh` only when the kind is enabled AND a peer stream read within its freshness window
  succeeded; otherwise `local-only`.

## Frontloaded Decisions

1. Placement: all three controls in the Sessions tab (operator stated this).
2. Scope: door + model only; thinking/effort deferred (cheap-to-change-after: additive UI over an
   API that already accepts them; nothing durable or user-visible until built).
3. Default semantics: creation-time seed, never a live layer; existing topics untouched by design.
4. Newness is not inferred in v1: the only seeded topics are ones the dashboard handler just created. Telegram-created topics are a named hold (#2085) on every machine.
5. Authority: no PIN anywhere in this feature (operator decision 2026-09-27 19:24 PDT, topic
   112490); the default and the explicit pick on create are Bearer + intent-header writes, audited;
   per-topic switches keep today's Bearer token-trust + bound-operator floor; creation seeds are
   `system:`-attributed store seeds with one disclosure line, reachable only from the create handler
   (the one place a pin lands on a topic with no bound operator yet — named, audited); a disclosure
   line is sent only when the helper returns `seeded`.
6. Regime parity: the seed's model axis obeys the write regime (dropped, never shadowed).
7. Multi-machine: v1 default is machine-local under `migrating-to-unified` (issue #2085, expires
   2027-03-25) with the destination design recorded in that issue, not here; Slack and remote tiles are read-only in v1
   (named user-visible limitations, not cheap).
8. `/sessions/create` joins the chokepoint's contract (resolve → spawn; adapter registration; no raw
   registry write) rather than adding a second resolver.
9. No `seedNewTopics` flag: clearing the default is the lever.

## Open questions

*(none)*
