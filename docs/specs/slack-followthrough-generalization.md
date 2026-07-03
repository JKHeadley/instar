---
title: Slack Follow-Through Generalization (Phase 2.3)
status: "converged (0C/0M) — internal multi-lens + gemini-2.5-pro + codex-cli/gpt all clean (2026-07-03); awaits operator approval before build"
review-convergence: "2026-07-03"
review-convergence-detail: "spec-converge ceremony over the DRAFT. Internal multi-lens (adversarial/security/integration-code-grounded/decision-completeness/keystone-drift) rounds 1-2 folded 2C+7M+4m; two external cross-model doors: gemini-2.5-pro (rounds 2-4: 1C → 2M → CLEAN) and codex-cli/gpt (0.137.0, one final pass: CLEAN — no critical or major). Load-bearing catch: the 1:1-session/DM cross-channel mis-delivery seam (gemini refined the internal fix — the hook now keys ONLY on INSTAR_CONVERSATION_ID, no Telegram fallback). Every fold re-walked against v1.3.737 code."
approved: true
approval-basis: "standing Session-A/B run operator preapproval — Justin, topic 29836, 2026-07-03 14:49 ('yes, please proceed with opus 4.8'), which explicitly covers spec approvals + in-scope reversible decisions. This spec is task 2 (the named critical path) and ships dev-gated DARK (reversible), squarely inside that envelope. Applying an already-granted go, not a self-grant."
eli16-overview: "slack-followthrough-generalization.eli16.md"
parent-principle: Structure beats Willpower
related-principles:
  - The Agent Carries the Loop
  - Close the Loop (Untracked = Abandoned)
roadmap: Phase 2.3 — follow-through generalization
reuses-specs:
  - durable-conversation-identity.md (§5 funnel, §6.1 increment 2, §6.3 eager mint, §7 bind-time authority)
  - action-claim-followthrough-sentinel.md (the Telegram registration model this spec generalizes)
supersedes: none
tags: [review-convergence]
---

# Slack Follow-Through Generalization (Phase 2.3)

> **One line:** A promise the agent makes in a **Slack** conversation must register as a durable commitment — the way a Telegram-born promise already does — so it survives a restart and is delivered by the machinery that already ships. The delivery side is DONE (durable-conversation-identity increment 2, merged + live-on-dev). The **registration TRIGGER on the Slack path is the only missing piece**, and this spec specifies exactly that, reusing the deployed machinery end to end.

---

## §0. Review log (convergence trajectory)

Grounded against the worktree's **v1.3.737** tree; every cited line/route was code-verified.

| Round | Lens | Findings (C / M / m) | Outcome |
|---|---|---|---|
| 0 | (draft) | — | Committed DRAFT |
| 1 | internal: adversarial, security, integration, decision-completeness | **1C + 4M + 4m** | All folded + re-walked (C1 1:1-session/DM mis-delivery; M lane-precedence, beacon-arming, shared cap, dev-gate+master coupling; m resolution parity, floor, dryRun sink, test-shape) |
| 2 | internal: fresh adversarial/security + **keystone-drift** | **0C + 3M** | Folded (bind-verify write-gating order; positive-id token-bearing honesty; keystone `action-claim observer` mislabel reconciled) |
| 2 (ext) | **gemini-2.5-pro** | 1C | Folded — my R1-C1 guard was *incomplete*: the hook's `INSTAR_TELEGRAM_TOPIC` fallback re-opened the DM mis-delivery. Grounded fix: hook keys ONLY on `INSTAR_CONVERSATION_ID`, no fallback. |
| 3 (ext) | **gemini-2.5-pro** | 2M | Folded — drop the ≥20-char floor (masked core targets); clamp POST payload to 16 KB. |
| 4 (ext) | **gemini-2.5-pro** | **0C + 0M → CLEAN** | Clean round on the gemini lens. |
| 5 (ext) | **codex-cli / gpt (0.137.0)** | **0C + 0M → CLEAN** | Clean on the GPT-tier lens — "CLEAN — no critical or major". |

**Convergence status:** **CONVERGED.** Internal multi-lens **converged**; **both** external cross-model families clean — **gemini-2.5-pro** (clean round 4) and **codex-cli/gpt** (clean, one final pass; codex was reachable at `/Users/justin/.asdf/installs/nodejs/22.18.0/bin/codex`, off the default PATH). Every fold was re-walked against the real v1.3.737 code. The **`review-convergence` tag is applied**; **`approved` is deliberately NOT set** — the build still awaits the operator's explicit go (the `/instar-dev` gate needs both tags). Open design questions for the operator remain in §10 (Q1–Q6), all with recommendations, none blocking.

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

This spec's **only** surface is the **registration trigger** — a genuinely-separate Phase 2.3 item (durable-conversation-identity §6.0 names "per-conversation Slack ack UX" and "Slack KYP auto-bind" as Phase 2.3; the registration trigger is the sibling that closes S7).

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

### §4.1a The load-bearing invariant: ONE session ↔ ONE conversation (and the deliberate DM carve-out)

**The whole mechanism rests on a session being 1:1 with the conversation it is registering for.** The Stop hook reads a **session-level** env var (`INSTAR_CONVERSATION_ID`, §4.4) once per turn — it has no turn-level knowledge of *which* conversation the just-finished turn belonged to. That is correct **only** when the session serves exactly one conversation.

- **Slack channel/thread asks (the S7 case) satisfy the invariant.** A channel/thread ask spawns a **dedicated, isolated** session (`targetSession=undefined`, `src/commands/server.ts:7740`; the thread session "NEVER folds into the DM lifeline", `:7738`), whose spawn env carries *that* conversation's minted id + a bind token scoped to it. 1:1 holds; the hook's session-level env is unambiguous.
- **Slack DMs fold into the shared `lifeline` session — they do NOT satisfy the invariant, and are OUT OF SCOPE for this spec.** A DM routes `isDM && !isThreadSession ? 'lifeline'` (`src/commands/server.ts:7740`) into the long-lived lifeline session, which also serves Telegram system traffic and is **reused** (its env is not re-applied on reuse). A DM-born promise firing the Stop hook would read the lifeline's *Telegram* env — registering the Slack promise on a **Telegram** topic and delivering the beacon into **Telegram** (positive-id legacy fail-open path, §4.3). That is a silent cross-channel **mis-delivery** — precisely the durable FD2 harm this spec must never cause.
  - **The structural guard — TWO parts, both required (R2-EXT-C1).** A cross-model pass caught that guarding only the injection side is **insufficient**: if the hook still *fell back* to `INSTAR_TELEGRAM_TOPIC` (which IS set on the lifeline), a Slack-DM promise would register against the lifeline's **Telegram** topic and deliver there — the mis-delivery, re-introduced through the fallback. So BOTH sides are guarded:
    1. **Injection (§4.4 change 1):** `INSTAR_CONVERSATION_ID` is injected **only for a dedicated session that is 1:1 with the freshly-minted conversation** (a channel/thread session, or a dedicated Telegram-topic session). It is **NOT** set on a reused/lifeline/shared session (`targetSession==='lifeline'`).
    2. **Hook keys ONLY on `INSTAR_CONVERSATION_ID` — no `INSTAR_TELEGRAM_TOPIC` fallback (§4.4 change 2):** if `INSTAR_CONVERSATION_ID` is absent the hook `exit(0)`s and registers nothing. A shared/lifeline session (which never carries it) therefore **genuinely does not register** — the accepted recall miss (§6), never a cross-channel mis-delivery. This is the grounded fix: a Claude Code Stop hook sees only its session **env**, never the turn's instar metadata, so it cannot itself tell a Slack-origin turn from a Telegram-origin turn inside a shared session — the only sound discriminator is "this session IS exactly one conversation," proven by the presence of a 1:1-scoped `INSTAR_CONVERSATION_ID`.
  - **Migration trade (deliberate):** a *dedicated Telegram-topic* session spawned **before** this change carries `INSTAR_TELEGRAM_TOPIC` but not `INSTAR_CONVERSATION_ID`, so it stops registering until it respawns (the always-overwrite hook + normal session churn closes the window; §8.5). This is safe because fleet action-claim is dark today (`messaging.actionClaim.enabled` code-default false) — there is no live registration to regress — and the alternative (keeping the fallback) re-opens the lifeline mis-delivery, which is strictly worse. Delivering DM follow-through durably needs a **turn-level** conversation id, a separate increment (§10-Q5).

### §4.2 Detection: two reuse lanes (deterministic, no LLM)

The trigger runs the two deterministic classifiers on `last_assistant_message` in a **strict precedence order — Lane A first, Lane B only on a Lane-A miss** (§4.2a). This precedence is not cosmetic: it is what prevents a **double registration** for a message that carries both a dev-verb and a time marker.

- **Lane A — action claims:** `classifyActionClaim` (`src/core/action-claim.ts:115`), unchanged. When it fires, register a `one-time-action` commitment keyed on the verb (existing behavior) **and RETURN** — do not run Lane B for this turn. Not explicitly beacon-armed; if the same text also carries a time marker, `record()`'s internal auto-beacon (`CommitmentTracker.ts:601-610`) arms it — so the dual-signal case ("I'll deploy in 10 min") registers **once**, verb-anchored, beacon-armed.
- **Lane B — time-boxed conversational promises (the S7 family):** runs **only when Lane A did not fire.** `CommitmentTracker.detectTimePromise` (`src/monitoring/CommitmentTracker.ts:1072`) is **promoted from an inside-`record()` beacon-sniff to a first-class trigger predicate** on the observe route: the route calls it purely to (a) decide whether to proceed and (b) build the Lane-B `externalKey` (§5). When it fires, the route calls `record()` with the Lane-B `externalKey` and **NO beacon fields** — `record()`'s internal auto-arm (same `detectTimePromise`, hedge-fixed once below) then sets `beaconEnabled:true` + the conservative cadence/hard-deadline from the SAME function. This is the lane that closes S7 (a time-boxed promise the dev-ops verb set would miss).

**Why the route must NOT pass `beaconEnabled:true` itself (the §4.2 fold — R1-C2).** `record()` auto-arms the beacon **only when `input.beaconEnabled === undefined`** (`CommitmentTracker.ts:601`). If Lane B passed `beaconEnabled:true` **without** a cadence, it would *suppress* the internal auto-arm and create a **cadence-less** beacon (a PromiseBeacon misbehavior). Passing **nothing** beacon-related is therefore both the max-reuse path AND the correct one: one detector, one source of truth, hedge-fixed in one place.

### §4.2a Precedence & dedup — exact route control flow

```
classify Lane A (classifyActionClaim)
  → fires  → record(actionclaim: key)        → RETURN (Lane B NOT run)
  → misses → classify Lane B (detectTimePromise)
               → fires  → record(timepromise: key, no beacon fields)
               → misses → { observed:true, registered:false, reason:'no-claim' }
```

At most **one** commitment is created per turn. A restated promise dedups within its own lane (§5); the shared per-topic cap (§5) bounds the total across both lanes.

**The S7 hedge fix (small, in-scope, reuses the function):** `detectTimePromise`'s numeric regex (`:1079-1081`) misses the hedge in "in **about** 5 minutes" because `about` breaks `in\s+(an?|\d+)`. A one-token widening — `in\s+(?:about\s+|around\s+|roughly\s+|~\s*)?(an?|\d+)\s*<unit>` — makes the exact S7 string register. This is a tested tweak to an existing pure function, not new machinery. (§10-Q1 carries whether to widen recall further.)

**Why deterministic-only:** the trigger must be cheap, total, and audit-clean (it runs on every finished turn). Both classifiers are pure functions with existing unit tests. No LLM hop is added to the turn-completion path.

### §4.3 Authority: enforce the §7 bind token on `/action-claim/observe` for minted ids

**The gap.** `POST /action-claim/observe` calls `commitmentTracker.record()` **without** verifying a bind token (`src/server/routes.ts:22313-22367`). Today that is safe *only* because the hook feeds **positive** Telegram ids, which are under the §7 legacy fail-open policy. The moment the hook feeds a **negative minted Slack id**, §7 becomes **load-bearing**: an unauthenticated caller could open a durable commitment (with a nagging beacon) on a conversation it does not own.

**The closure (reuse, don't rebuild).** The **same** verification block `POST /commitments` runs (`src/server/routes.ts:22137-22206`) is factored into one shared helper both routes call (a refactor, not a second implementation — a second copy is the drift the §7 golden test forbids), reusing `ctx.conversationBindAuth`:

1. Require `X-Instar-Bind-Token` (from the hook, §4.4). Missing → typed `403 conversation-bind-not-authorized` + the existing deduped attention item; **fail-closed**.
2. `bindAuth.verify(token)` the MAC. Invalid → same 403.
3. Assert `numericTopicId ∈ payload.bootstrapConversationIds`. Foreign id → same 403 (the exact refusal `POST /commitments` raises).
4. On success, pass `boundBy:"session:<payload.sessionName>"` into `record()` (identical to `POST /commitments`).

**Ordering (R2 — the check gates the WRITE, not the observe).** The bind-verify runs **on the register path only** — after a lane has fired and immediately before `record()`. A **no-claim** observe returns `{registered:false, reason:'no-claim'}` **without** any bind check, so a probing / non-claim turn never trips the 403 attention item. Sequence: parse → classify (Lane A, else Lane B) → **on a lane hit:** bind-verify (per the id's sign) → cap → `record()`.

**Keystone reconciliation (R2 — the action-claim observer is a ROUTE, not an in-process caller).** durable-conversation-identity's R4-minor-3 / minor-3 (`durable-conversation-identity.md:2536`, `:3359`) *lists* "the action-claim observer" among in-process server-self callers that carry `boundBy:"server:<component>"` and **bypass** the route token gate. That parenthetical is **inaccurate for the actual architecture**: the action-claim path is the HTTP route `/action-claim/observe`, driven by the Stop hook over HTTP — it has never been an in-process call. By the keystone's **own** load-bearing discriminator — *"anything arriving over the HTTP route needs a session token regardless of self-description; the discriminator is the code path, not the caller's self-description"* — the observe route takes the **session-token** gate (`boundBy:"session:<name>"`), exactly as §4.3 specifies. So this spec is the keystone's rule applied correctly, **not** a contradiction of it. **Cross-spec correction owed:** the keystone's minor-3 parenthetical should drop "action-claim observer" from its in-process examples (carried to the operator via §10 / the eli16). A builder must NOT wire the observe route to stamp `boundBy:"server:action-claim"` or skip the token.

**Positive-id honesty (R2 — the hook now sends the token on BOTH paths).** Because the generalized hook sends `X-Instar-Bind-Token` whenever `INSTAR_BIND_TOKEN` is set (§4.4) — which is every post-migration session, Telegram included — a **positive** `topicId` observe is now **token-bearing** and therefore rides the **R6-minor-4 token-bearing arm** of the shared helper (`routes.ts:22173-22185`): the positive id is validated against the token's bootstrap set (it always matches, since `INSTAR_CONVERSATION_ID` and the token are minted over the identical set — §4.4/R1-C4), and `boundBy` is stamped. This is **not** "byte-identical" to today's un-gated observe — it is the same behavior `POST /commitments` already has for a token-bearing positive id, and it is a strict improvement (a durable stamp). A **token-LESS** positive observe (a legacy session spawned before the bind-token increment, no `INSTAR_BIND_TOKEN`) stays on the **legacy fail-open** arm + the R7-minor-2 straggler backstop — unchanged. Net: no Telegram regression; negative (Slack minted) ids are hard-gated fail-closed.

**Net:** the Slack session self-registers under **its own** authority (its `INSTAR_BIND_TOKEN`, scoped to its minted id); no other principal can open a commitment on that conversation; in-process callers are unaffected.

### §4.4 The seam changes (exhaustive — this is the whole build)

1. **Spawn env (`src/core/SessionManager.ts` ~:4268).** Inject a **channel-neutral** `INSTAR_CONVERSATION_ID` **using the IDENTICAL resolution the bind token is minted over** (`bootstrapConversationIds[0] ?? (typeof telegramTopicId === 'number' ? telegramTopicId : undefined)`, mirroring `:4245-4246`) — so the posted id is **always** an element of the token's `bootstrapConversationIds` set (else the §4.3 gate would 403 its own session; R1-C4). For Telegram this equals the positive topic id; for a dedicated Slack channel/thread session it is the minted negative id. **1:1 GUARD (R1-C1):** inject it **only for a dedicated session that is 1:1 with the freshly-minted conversation** — do **NOT** inject it on a reused/lifeline session (`targetSession==='lifeline'`), so a Slack DM folded into the lifeline falls back to `INSTAR_TELEGRAM_TOPIC` and stays untracked rather than mis-delivered (§4.1a). `INSTAR_BIND_TOKEN` is already injected (`:4243-4247`).
2. **The Stop hook (`PostUpdateMigrator.getActionClaimFollowthroughHook`, `src/core/PostUpdateMigrator.ts:11843-11903`).**
   - Topic source: read `process.env.INSTAR_CONVERSATION_ID` **only** — **no** `INSTAR_TELEGRAM_TOPIC` fallback (R2-EXT-C1: the fallback re-introduces the lifeline mis-delivery). Absent → `exit(0)`, register nothing (a shared/lifeline/legacy session is a safe miss, never a mis-registration). Accept a **negative** parsed id (drop the implicit "must be a Telegram positive" assumption; `Number.isFinite` already admits negatives, verified `:11883`). This REPLACES the current `INSTAR_TELEGRAM_TOPIC` read at `:11880`.
   - Bind token: read `process.env.INSTAR_BIND_TOKEN`; when set, send it as the `X-Instar-Bind-Token` header on the POST.
   - **Drop the ≥20-char floor (R3-EXT-M1).** The current `message.length < 20 → exit(0)` guard (`:11881`) runs *before* classification and silently masks core targets — "I'll fix it" (11), "back in 10 min" (14), "I'll deploy" (11). The **classifiers are the correct semantic filter** (both are high-precision: first-person + a closed verb / a time marker — a bare "ok"/"done" never classifies), so the length floor buys nothing but blindness. Replace it with a trivial `!message` empty-guard only. (Shared-hook note: this also lifts the floor on the Telegram path — an intended strict improvement, riding the same dark gate.)
   - **Bound the POST payload (R3-EXT-M2).** The hook currently posts the **raw** `last_assistant_message`; a pathological reply (an agent pasting a large log) would POST a multi-MB body that the server's JSON body-parser limit would reject (→ a silent non-registration for that turn), and needlessly runs the regexes over megabytes. Truncate to a safe upper bound (`message.slice(0, 16384)`) **in the hook** before POSTing — generous enough that every real reply is whole; a promise buried after 16 KB of pasted content is an accepted rare miss. (The route already stores only `message.slice(0,500)` as `agentResponse`; this bounds the wire + classify cost too.)
   - Everything else (`messaging.actionClaim.enabled` gate, `always exit(0)`) unchanged. Regenerated on every migration (`instar/` hooks are always-overwritten — §8.5).
3. **The route (`src/server/routes.ts` `/action-claim/observe`, :22313).** Additions, all riding the existing never-500 contract:
   - the §4.3 negative-id bind-token gate (shared helper);
   - the **Slack dev-gate read (R1-C8):** for a **negative** `topicId`, resolve `messaging.actionClaim.slack` via `resolveDevAgentGate` (live-on-dev, dark-fleet) and honor its `dryRun` (§8.1); a positive id is unaffected;
   - the §4.2a Lane-A-precedence control flow (Lane A first-and-return, else Lane B);
   - the Lane-B `detectTimePromise` predicate + Lane-B `externalKey` (§5), calling `record()` with **no** beacon fields (§4.2 fold);
   - the **per-topic cap widened to count BOTH lanes (R1-C3):** the open-commitment filter counts `externalKey` starting with `actionclaim:` **OR** `timepromise:` against ONE shared budget (`messaging.actionClaim.perTopicCap`, default 5) — today's filter counts only `actionclaim:` (`:22340-22342`), so Lane-B rows would escape the cap unless widened.

### §4.5 Which process owns registration — summary

The **responding Slack session** owns registration, via **its own post-turn Stop hook**, posting to **its own machine's** server, under **its own** bind-token authority. The server-side route + record + beacon + funnel are shared, channel-neutral, and already deployed.

---

## §5. Idempotency & dedup

- **Lane A (action claims):** unchanged — `externalKey='actionclaim:'+sha256(topicId|verb).slice(0,16)` (`src/server/routes.ts:22336`). A restated action claim across turns updates ONE commitment (`record()` short-circuit, `CommitmentTracker.ts:562-565`).
- **Lane B (time-boxed promises):** `externalKey='timepromise:'+sha256(topicId|normalizedPromiseText).slice(0,16)`, where `normalizedPromiseText` = lowercased, whitespace-collapsed, time-token-preserving slice of `last_assistant_message`. An **exact restatement** dedups to ONE commitment; a **reworded** restatement opens a new one (weaker than the verb anchor). The **per-topic cap (default 5, `messaging.actionClaim.perTopicCap`)** bounds the blast radius of reworded restatements; auto-expiry (6 h) sweeps stale rows. (§10-Q2 carries whether Lane B needs a stronger cross-restatement anchor.)
- **The cap is ONE shared budget across both lanes (R1-C3).** The route's open-commitment count filter matches `externalKey` starting with `actionclaim:` **OR** `timepromise:` (the pre-existing filter matched only `actionclaim:`, `routes.ts:22340-22342`, so a Lane-B row would have escaped the cap). A topic's total durable action/promise surface is therefore bounded at `perTopicCap` regardless of lane mix — the Bounded-Notification guarantee §5's "bounds the blast radius" line depends on.
- **No double-count-then-double-create:** because Lane A returns before Lane B (§4.2a), a single turn contributes at most one row, so the cap is never spuriously consumed twice for one utterance.
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
2. **Missed classification** (neither lane fired, OR the promise was made in a lifeline-folded Slack DM (§4.1a), OR a promise buried past the 16 KB hook truncation (§4.4 change 2, R3-EXT-M2)): **silent by design** — this is the accepted recall trade above. It is bounded by the two detectors' coverage + the 1:1-session invariant, and improved only by §10-Q1's recall knob / §10-Q5's turn-level DM id. (The old ≥20-char floor that previously masked terse promises is **removed** — R3-EXT-M1; the classifiers are now the only precision filter.)

**We NEVER fail toward:** a duplicate commitment, a spurious beacon, or a commitment on a conversation the caller does not own (§4.3 fail-closed).

---

## §7. Multi-machine reality — register on the owning machine, structurally

The **Mini** fronts Slack (serving-lease holder); Slack inbound + `mintForInbound` run on the Mini (`src/commands/server.ts:7575`), so **the Mini owns the minted conversation id and its registry row**. Registration MUST happen there. This is enforced **by construction**, not convention:

0. **Precondition — the 1:1-session invariant (§4.1a).** The reasoning below holds because a Slack channel/thread ask spawns a **dedicated** session bound to exactly this conversation. A DM folded into the shared lifeline is explicitly excluded (§4.1a) precisely so this "the session IS the conversation" chain stays sound.
1. The Slack conversational session is spawned **on the Mini** (`spawnInteractiveSession`, `src/commands/server.ts:7742`), so its Stop hook posts to the **Mini's** `localhost` server.
2. The session's `INSTAR_BIND_TOKEN` is minted by the **Mini's** `conversationBindAuth` using the **Mini's** `bindTokenSecret` (`src/commands/server.ts:5278-5279`), so it verifies **only** on the Mini. A hook that somehow posted to a peer would be `403`-refused (different secret) — fail-closed, not a wrong-machine write.
3. `record()`'s `conversationBinder.bind()` resolves the minted id against the **local** registry (`CommitmentTracker.ts:580-587`); a peer that never minted the id would throw `conversation-bind-unresolvable` → `409`, not a silent divergent row.
4. Write-admission refuses a minted-id durable write on a non-owner machine (the general standby-write policy), so a peer cannot open the row even if the other guards were bypassed.

**Conversation moves (out of scope, already handled):** if the topic later moves machines, the commitment's denormalized `boundTuple` travels with it and `PromiseBeacon` re-resolves the live owner at speak time (`src/commands/server.ts:13321-13325`) — increment-2 machinery, not re-specified here.

---

## §8. Rollout, config, kill-switch, migration parity

### §8.1 Graduated rollout (dev-gated dark → dev live → operator fleet flip)

- **Trigger gate:** a **new** dryRun-first, dev-gated flag `messaging.actionClaim.slack` = `{ enabled?: omitted, dryRun: true }`, registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`), so `resolveDevAgentGate` flips it **live-on-dev, dark-on-fleet** (the same pattern as `conversationIdentity.followThrough.enabled` at `:168`). `enabled` is **OMITTED** — never materialized as a literal `false` (the #1001 trap). The **observe route reads this gate for a NEGATIVE topicId** (§4.4 change 3): dark → the Slack (negative-id) lane is a strict no-op; dryRun → would-register audit only.
- **⚠ The master-`enabled` precondition (R1-C8 — do not skip).** The `messaging.actionClaim.slack` sub-flag governs the route's Slack lane, but the **Stop hook itself exits before any POST unless `messaging.actionClaim.enabled` is true** (`PostUpdateMigrator.ts:11873`, `:11876`). So the Slack lane cannot go "live-on-dev" via the sub-flag alone — the dev soak REQUIRES setting **`messaging.actionClaim.enabled: true` on the dev agent** (the whole sentinel's master gate). Consequence to accept deliberately: enabling the master on dev also activates **Lane A action-claims for Telegram** on dev (existing behavior) and — via the shared route — **Lane B time-promises for Telegram** on dev (§8.4). This is the intended one-detector-set posture; it is called out so the operator does not read the sub-flag as independently sufficient.
- **dryRun semantics + audit sink (R1-C6):** while the resolved `dryRun` holds, the observe route runs the full classify + Lane-precedence + bind-verify + would-register decision, appends **one audit line to `logs/action-claim-observe.jsonl`** (`{ts, topicId, lane, verb|promiseHash, bindVerdict, wouldRegister:true, dryRun:true}` — the append is **best-effort/try-catch**, "audit is observability", so a log-write failure can never break the route's never-500 contract), and returns `{observed:true, registered:false, dryRun:true, wouldRegister:true, ...}` — but performs **no** `record()`. A deliberate `dryRun:false` on dev enables real registration for the live proof (§9.4).
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
- **Spawn env** (`INSTAR_CONVERSATION_ID`): code — ships with the server; no config migration. **Migration window (R2-EXT-C1):** because the hook now keys ONLY on `INSTAR_CONVERSATION_ID` (no `INSTAR_TELEGRAM_TOPIC` fallback), a dedicated Telegram-topic session spawned before this change does not register until it respawns and picks up the env. Safe (fleet action-claim is dark; no live registration to regress); the always-overwrite hook + normal churn close it. The shared lifeline is *intended* to never carry the env (§4.1a).
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

- `POST /action-claim/observe` with a **negative** topicId + a valid `X-Instar-Bind-Token` + a time-promise message → **200** `{observed:true, registered:true, commitmentId, externalKey}` (the observe route's real shape — **not** the `201` of `POST /commitments`), and `GET /commitments` shows the row bound to the minted id with the denormalized `boundTuple` and `beaconEnabled:true` (armed by `record()`'s internal auto-detect, not a route-passed flag — §4.2).
- Same with **no** bind token → `403 conversation-bind-not-authorized`, no row, and the deduped attention item present.
- Same with a **foreign** minted id (not in the token's bootstrap set) → `403`, no row.
- **Lane precedence (R1-C9):** a message with BOTH a dev-verb AND a time marker ("I'll deploy in 10 min") → exactly **ONE** row, `externalKey` starting `actionclaim:`, beacon-armed; assert NO `timepromise:` row was also created.
- **Shared cap (R1-C3):** a mix of `actionclaim:` and `timepromise:` rows on one topic is bounded at `perTopicCap` (default 5) — the cap counts both prefixes.
- Idempotency: two identical observes (same lane) → ONE row.
- dryRun: negative topicId with `messaging.actionClaim.slack` resolving `dryRun:true` → a `logs/action-claim-observe.jsonl` would-register line + `{registered:false, dryRun:true, wouldRegister:true}`, **no** row.
- Feature-off (`messaging.actionClaim.enabled:false`) → `{observed:false, registered:false, reason:'feature-disabled'}`, no row.

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

- **Q1 — Detection recall knob.** Lanes A+B (+ the hedge fix) close the S7 case and the dev-ops/time-boxed families. Do we stop there (highest precision), or widen Lane B's recall to catch bare-verb conversational promises ("I'll send you the summary", "I'll wire that up") that carry **no** time marker? Widening buys recall at the cost of false nagging-beacons (the FD2 harm) and is the riskier, LLM-tempting direction. **Recommendation: ship A+B+hedge first; treat further recall as a separately-soaked later increment.**
- **Q2 — Lane-B dedup strength.** Lane B keys on normalized promise text, so a **reworded** restatement of the same promise opens a second (cap-bounded, expiring) commitment. Is the per-topic cap + 6 h expiry an acceptable bound, or does Lane B need a coarser per-topic-time-window anchor (fewer duplicates, but risks collapsing two genuinely-distinct promises)? **Recommendation: ship the content-hash key + cap; revisit only if dev soak shows duplicate churn.**
- **Q3 — Telegram time-promise registration (§8.4).** The shared route means Lane B also starts registering Telegram time-boxed promises when the fleet flag graduates. Intended improvement, or should Lane B be Slack-scoped until a separate Telegram soak? **Recommendation: keep it shared (one classifier set), rely on the shared dark gate + dev soak.**
- **Q6 — Keystone doc-correction (cross-spec).** durable-conversation-identity's R4-minor-3 / minor-3 parenthetical mislabels "the action-claim observer" as an in-process server-self caller (§4.3 reconciliation). The action-claim path is the HTTP route + Stop hook, so it takes the session-token gate per the keystone's own discriminator. **Recommendation: land a one-line keystone edit dropping "action-claim observer" from that in-process example when the build PR touches the shared bind-verify helper — no design decision, just a doc-truth fix so the two specs never read as contradictory.**
- **Q5 — Turn-level conversation id for shared (lifeline) sessions.** §4.1a scopes this spec to dedicated channel/thread sessions and deliberately leaves Slack-DM (lifeline-folded) promises untracked, because the Stop hook reads a session-level env id and a shared session serves many conversations across turns. Closing the DM gap needs a **turn-level** conversation id — e.g. the hook reading the just-finished turn's conversation from the injected message metadata (`message.metadata.conversationId`, already minted at `server.ts:7575`) rather than a session env var, or the send-chokepoint backstop of §11-A. **Recommendation: separate increment; do NOT widen 2.3 to chase it — the guard (don't set `INSTAR_CONVERSATION_ID` on the lifeline) makes the DM case a safe miss, not a mis-delivery.**
- **Q4 — Should a server-side backstop exist?** The Stop hook can be absent on a session spawned before the migration, or crash. Do we want a low-frequency `commitment-detection`-style backstop that scans Slack conversation transcripts for missed promises (recall insurance), accepting its cadence lag and cost? **Recommendation: NO for Phase 2.3 (keep minimal); the always-overwrite hook migration (§8.5) closes the stale-hook window, and recall-insurance is Q1's territory.**

---

## §11. Alternatives considered & rejected

- **A. In-process outbound-send classifier** (classify at the `POST /slack/reply/:channelId` / `sendToChannel` chokepoint, register in-process with `server:` authority). **Rejected as primary:** it does not generalize the Telegram model (a different mechanism), it must discriminate the session's reply from permission-templates / ephemerals / sentinel notices that share `sendToChannel`, and it centralizes authority away from the loop-carrying session. It **is** the natural **backstop** if hook-firing reliability proves insufficient (revisit under §10-Q4) — but it is not needed to close S7 and adds new machinery, so it is out of scope.
- **B. The responding session calls `POST /commitments` directly** (no hook) — this is the **willpower** path the bootstrap prompt already tries (`src/commands/server.ts:7642-7647`) and that S7 proved fails. Rejected: not structural.
- **C. Extend the `commitment-detection` job to Slack.** Rejected: it writes to the **evolution-actions** ledger (`POST /evolution/actions`), not `CommitmentTracker`/`PromiseBeacon`; it is cadence-delayed (`*/5`) — the exact 10 s window S7 shows is fatal — and it is Telegram-JSONL-bound (`src/commands/init.ts:3558-3573`). It is a parallel system, not this path.
- **D. A new bespoke Slack-promise route / store.** Rejected outright: maximal new machinery, exactly what review rounds shred; every needed primitive already exists.

---

## §12. Build sequencing (for the /instar-dev increment that follows convergence)

1. `detectTimePromise` hedge fix + unit tests (isolated, no wiring). One fix covers both the route predicate AND `record()`'s internal auto-arm (same function).
2. Factor the `POST /commitments` §7 bind-verify block (`routes.ts:22129-22206`) into a shared helper; prove `POST /commitments` unchanged (the §7 golden test).
3. `/action-claim/observe`: add the negative-id bind gate (shared helper) + the negative-id `messaging.actionClaim.slack` dev-gate/dryRun read + the §4.2a Lane-A-precedence control flow + Lane-B predicate + Lane-B `externalKey` + the **cap filter widened to both prefixes** (R1-C3) + the `logs/action-claim-observe.jsonl` dryRun audit sink (R1-C6); integration tests incl. the lane-precedence single-row assertion (R1-C9).
4. `INSTAR_CONVERSATION_ID` spawn env (`SessionManager.ts`) — the bind-token-identical resolution + the **1:1 guard** (not on `targetSession==='lifeline'`; R1-C1/C4).
5. Generalize the Stop hook body (`getActionClaimFollowthroughHook`) — topic source = `INSTAR_CONVERSATION_ID` **only** (no `INSTAR_TELEGRAM_TOPIC` fallback; R2-EXT-C1) + bind-token header + drop the ≥20-char floor (R3-EXT-M1) + 16 KB payload clamp (R3-EXT-M2); hook regression (no-bare-require, always exit 0).
6. `messaging.actionClaim.slack` dev-gate registration + `migrateConfig` existence-check + CLAUDE.md template paragraph.
7. E2E aliveness test (incl. the negative-lifeline-session assertion: a lifeline session does NOT carry `INSTAR_CONVERSATION_ID`).
8. Live-proof S7 round-trip on dev (§9.4; requires `messaging.actionClaim.enabled:true` on dev per §8.1); signed matrix.

Each step is independently testable; steps 1–3 are shippable behind the dark gate before the Slack env/hook seam exists.
