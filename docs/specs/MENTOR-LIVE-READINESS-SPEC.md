---
title: Agent-to-Agent Telegram comms primitive + Mentor live-readiness (its first consumer)
owning-layer: messaging (new primitive) + scheduler/server (mentor consumer)
status: converged
review-convergence: true
review-iterations: 1
review-reviewers: lessons-aware, integration, adversarial
co-designer: instar-codey (Threadline thread 14629926, recipient-side detection + anti-loop handler design folded)
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-27 — after substrate + /idle + dollar-cap user-fidelity corrections)
supersedes-rounds: 2 prior convergence rounds on file-based mentor-outbox design (committed but re-architected after Justin substrate correction, topic 13435, 2026-05-27)
supervision: tier1
amendments:
  - date: "2026-05-28"
    by: "echo"
    approved-by: "justin (topic 13435 — Codey-dogfooding 'P3 - agreed')"
    summary: "Dedicated mentor topic: add optional mentor.mentorTopicId; the mentor exchange's telegramTopicId resolves to mentorTopicId ?? menteeTopicId, so mentor a2a no longer interleaves with the human↔mentee conversation topic. Backward-compatible (falls back to menteeTopicId)."
---

# Agent-to-Agent Telegram comms primitive + Mentor live-readiness

> **Amendment 2026-05-28 — dedicated mentor topic (P3).** During the Codey-over-Telegram dogfooding run, the mentor cycle's a2a check-ins were observed interleaving with the topic Justin chats with Codey in (`menteeTopicId`, topic 458) — the mentor delivery passed `menteeTopicId` as its `telegramTopicId`, which drives both the `/a2a/inbox` body (where the mentee binds its session + reply) and the Telegram fallback. Fix: an optional `mentor.mentorTopicId`; `resolveMentorDeliveryTopic(cfg)` returns `mentorTopicId ?? menteeTopicId`, so configuring a dedicated topic moves the entire mentor exchange off the human conversation topic. Unset → unchanged behavior.

## Summary

Two fixes wrapped together because the consumer drove the primitive's design:

1. **A new agent-to-agent Telegram comms primitive** — a robust, recipient-knows-it's-from-
   an-agent channel any agent can use to message another agent's bot, with the indicator
   *and* the anti-loop machinery as first-class infra. Justin's framing (2026-05-27):
   "robust infra that indicates the message is from another agent… leverage infra to
   prevent the ping pong trap." Reusable for any future agent-to-agent Telegram scenario;
   the mentor is its first consumer.
2. **Mentor live-readiness** — three remaining gaps in the existing mentor system that
   block a real supervised live cycle against Codey (real idle signal, the agent-comms
   delivery — now via the primitive — replacing the broken file-outbox, and a quota-aware
   budget on actual subscription metrics).

## Design-drift correction (honoring this morning's learning)

The first version of this spec used a file-based outbox for mentor delivery — convergence
hardened it heavily, all the way to round 2 — and Justin caught that it solved the wrong
problem. The cross-agent spawn loop was a *discipline* issue (don't auto-reply to courtesy
acks); I'd misread it as a *substrate* issue and moved off Telegram, which broke the
authenticity of the simulation (Codey would process file lines, not user messages, exactly
what we DON'T want to test). Two rounds of reviewer review didn't catch it because each
reviewer asked "is this file-based design sound?" not "is file-based the right substrate?"
Recorded the meta-lesson alongside today's earlier one
([[feedback_report_verified_not_intended_behavior]]): convergence checks *how well a
design holds up*, not *whether the design's framing is correct* — that's the user's call,
and the spec must surface the substrate choice explicitly, not bury it.

## The three live-readiness gaps (unchanged from prior draft)

### Gap 1 — The whole "is the mentee free?" gate is the wrong design (Justin correction)

`AgentServer.ts:~651`: `isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0`
is a stub that always returns true so the mentor never runs. But the deeper issue (Justin,
2026-05-27 topic 13435): **a user doesn't probe the agent's state before sending a
Telegram message — they just send.** Whether Codey is mid-task is HIS concern, on his
side. Replacing the stub with a real `/idle` probe (the prior draft's approach) violates
the same user-fidelity principle as the file-outbox substrate error — both are "engineering
convenience that no real user does." The fix is to **remove** the gate, not to make it
"real." The actual cadence gates that ARE genuine user-behavior live on Echo's side:
schedule (15-min tick), budget (token cap + quota), and **outstanding-prompt tracking**
(don't send again before hearing back — that's how real users behave). See §Fix 2b
"Implementation surface" item 4.

### Gap 2 — Mentor delivery to Codey does not exist as a real user-channel

The current `deliverToMentee` writes JSON lines to a file nothing reads, AND the file
substrate doesn't simulate a user interaction even if it were read. Both problems are
fixed by the new primitive: route mentor messages through Telegram (the real user channel)
so Codey processes them with his normal user-message pipeline.

### Gap 3 — Budget is dollar-denominated on a token-subscription, unenforced, silent on trip

`AgentServer.ts:~656-664`: `budgetOk` checks a run-count; `dailySpendCapUsd: 0.5` is a dead
config field; Echo runs on a Claude subscription (no per-token dollar charge to cap). The
real cost is tokens against rolling quota — already tracked by `QuotaTracker.canRunJob` +
`TokenLedger` (`attribution.component='mentor-stage-b'`).

## Fix 1 — REMOVED (Justin user-fidelity correction, 2026-05-27)

The prior draft proposed a `/idle` endpoint on Codey's server + Echo-side probe. **Removed
entirely** per Justin: a real user doesn't probe agent state before sending a Telegram
message. The mentor's gates are all Echo-side and match real user behavior:
- **Schedule** (15-min tick) — cadence.
- **Budget** (Stage-B token cap + quota-aware) — Echo's own quota pressure.
- **Outstanding-prompt tracker** (don't send while a prior is unanswered within
  `mentor.replyTimeoutMs`) — natural user behavior of not pestering before getting a reply.
  Detailed in §Fix 2b "Implementation surface" item 4.

`isMenteeBusy` is **deleted**, not replaced. The previous `safeWindowOpen` branch in
`MentorOnboardingTick` collapses to `budget.ok && !outstandingForThisMentee` — both
real Echo-side concerns. Codey's side no longer ships the `/idle` endpoint; his side is
relieved of that ask (he handles availability via his normal user-message processing,
which is exactly what we're testing).

## Fix 2a — Agent-to-Agent Telegram Comms primitive (new infra)

**Module:** `src/messaging/AgentTelegramComms.ts` (new) — generic primitive, mentor-agnostic.

### The marker

Every agent-to-agent message carries a structured, visible prefix in the message body:

```
[a2a:from=<senderAgent> to=<recipientAgent> role=<role> id=<stable-uuid> corr=<uuid> ts=<unix-ms> v=1]

<message body>
```

- **Visible in chat** — humans can audit at a glance, AND **the Telegram chat history alone
  is enough to reconstruct the round-trip when ledgers are unavailable** (Codey's
  point — `corr` in the visible marker, not just audit metadata, so the trace is the chat).
- **Field-value charset (Codey's tightening):** `[A-Za-z0-9._:-]+` for `from`/`to`/`role`/
  `id`/`corr`; positive integer for `v` and `ts`. UUIDs recommended for `id`/`corr`; parser
  accepts any token matching the charset (so ULIDs etc. work for future senders).
- **`corr` is REQUIRED in the parser** (round-2 adversarial F3 closure): a missing or empty
  `corr` is a malformed marker → DROP (`agent-marker-malformed`). Prompts set
  `corr=<id>` (self-correlate); replies set `corr=<prompt's id>` (threads the round-trip).
  This prevents the cycle-detection key from collapsing on `corr=undefined` and tripping on
  unrelated traffic.
- **`ts` is REQUIRED** (round-2 adversarial F2 — replay defense without HMAC): unix-ms
  timestamp. Recipient REJECTS any marker with `|now - ts| > a2a.skewWindowMs` (default
  24h) as `agent-marker-stale-or-future`. Caps replay window independent of processed-id
  ledger eviction; HMAC-signed markers are a v2 concern. <!-- tracked: topic-13435 -->
- **Parser is strict** — regex anchored to start, consumes only the first line + the
  required blank separator. Anything marker-*like* but malformed (charset violation,
  missing required field, broken syntax) is an **A2A security event**: drop + audit row,
  NEVER fall through to normal user handling (Codey's point — avoids spoof / broken sender
  accidentally turning into a regular prompt).
- **Versioned** (`v=1`) — schema bumps are explicit.
- **No HMAC v1** — recipient trusts the marker if the sender Telegram bot identity is in
  the recipient's known-agents allowlist (the structural identity check is the Telegram bot
  ID, not the marker text). HMAC-signed markers are a v2 concern if cross-machine trust
  matters. <!-- tracked: topic-13435 -->
- **Roles defined**: `mentor`, `mentor-reply`, `coord`, `coord-reply`, `notify` (extensible).

### Sender side

```ts
sendAgentMessage({
  fromAgent: 'echo',
  toAgent: 'instar-codey',
  toBotToken: cfg.codey.mentorBotToken,   // the recipient's mentor-bot token
  toTopicId: cfg.codey.mentorTopicId,     // the dedicated topic in recipient's setup
  role: 'mentor',                          // MUST be in the caller's allowed-roles list
  message: '<the prompt>',
  correlationId?: 'optional-existing-id-for-reply-threading',
}): Promise<{ ok: boolean; sentMessageId?: string; a2aId?: string; reason?: string }>
```

- **Generic, not mentor-specific** (Codey's point): the primitive is reusable; caller
  passes the `role` from a constructor-time allowed-roles list. For Codey's first
  consumer, the only permitted outbound role is `mentor-reply` (produced only by the
  mentor handler).
- Instantiates (or reuses) a `TelegramAdapter` for the recipient's bot.
- Mints a stable `a2aId` (UUID) if `id` not supplied; prepends the marker; calls
  `sendToTopic(toTopicId, marker+body)`.
- **Returns `a2aId`** alongside `sentMessageId` so the caller can log the exact marker id
  next to its local assistant response id (Codey's tightening).
- **Audit row schema** (`state/a2a-sent.jsonl`, append-only): `localTs`, `direction:
  'sent'`, `fromAgent`, `toAgent`, `role`, `id`, `corr` (if present), `telegramBotId`,
  `topicId`, `sentMessageId`, `result: 'ok' | 'failed'`, `reason` (on failure). **No
  tokens or secrets in ledgers.**

### Recipient side

A new incoming-message handler registered with `TelegramAdapter.onMessage`. **The handler
runs BEFORE normal user routing** so agent-origin messages cannot accidentally trigger
generic courtesy/ack behavior on the user-message path (Codey's sharpening).

```ts
agentMessageHandler(rawMsg): { handled: boolean; routedTo?: string; dropReason?: string }
```

**Bot-identity check — round-2 adversarial F1 closure.** The Telegram `Message.from` shape
today carries `{id, first_name, username?}` but NOT `is_bot` or `sender_chat` (verified in
`src/messaging/TelegramAdapter.ts`). This work extends the typed Message to expose
`from.is_bot` and `sender_chat` (Telegram's wire format already carries them; only the
type surface needs lifting). The allowlist key is:
- `sender_chat.id` when present (group bot-as-channel relay), OR
- `from.id` AND `from.is_bot === true` (DM / topic post by a bot).

A marker-bearing message with `from.is_bot !== true` and no `sender_chat` is **a user
typing a marker-shaped string** — DROP as `agent-marker-spoofed-by-user`, NEVER route to
the role-handler. Without this, a human user (Justin, in his own chat) typing
`[a2a:from=echo to=instar-codey role=mentor id=… corr=… ts=… v=1]\n\n<body>` would route as
real mentor traffic. (Verified: today's `Message.from.id` check would pass on a Justin
message.)

**Routing matrix (Codey-designed + round-2 adversarial-hardened, explicit + audited at every branch):**

| Incoming shape | Decision | Audit row |
|---|---|---|
| No marker present | Fall through to normal user handling | (not an A2A event) |
| Marker-like-but-malformed (charset / missing field / syntax / missing `corr` / missing `ts`) | **DROP** (security event, NEVER fall through) | `agent-marker-malformed` |
| Marker with `\|now - ts\| > skewWindowMs` (default 24h) | DROP (replay defense) | `agent-marker-stale-or-future` |
| Marker but `from.is_bot !== true` AND no `sender_chat` (a real user typed it) | DROP (user-spoof defense) | `agent-marker-spoofed-by-user` |
| Valid marker, `to !== <localAgent>` | DROP | `agent-marker-wrong-recipient` |
| Valid marker, unsupported `v` | DROP | `agent-marker-unsupported-version` |
| Valid marker, `from` not in allowlist OR sender bot-ID mismatch | DROP (spoof defense) | `agent-marker-unknown` |
| Valid marker, `id` already in processed-id ledger | DROP (idempotency — Telegram retry / adapter restart) | `agent-marker-duplicate` |
| Valid allowlisted, `role` NOT in **per-source** allowed-incoming-roles for that `from` | DROP (compromised-source defense — see anti-loop #2) | `agent-marker-role-not-allowed-from-source` |
| Valid allowlisted, `role` recognized for that source | Strip marker → route to role-handler → record `id` in processed ledger | `agent-marker-routed` |
| Valid allowlisted, role unexpected for this recipient (e.g. `mentor-reply` on Codey) | DROP (don't fall through to user) | `agent-marker-unexpected-role` |
| Valid allowlisted, unknown role | DROP | `agent-marker-unknown-role` |

**Processed-id ledger (Codey's idempotency point):** a small persistent set of recently-
processed `id`s (bounded — last N=10_000 or M=30 days, whichever first) so retries/restarts
can't re-inject the same prompt. File-backed at `state/a2a-processed-ids.json` via
`SafeFsExecutor.atomicWriteJsonSync`, CAS single-writer.

**Anti-loop discipline (sharpened per Codey):**
- Agent-origin Telegram messages suppress ALL generic courtesy/ack behavior **before**
  normal user routing sees them (the handler runs first).
- The role-handler is the only producer of any outgoing message in response.
- A role-handler may only produce roles from an **explicit allowlist** for that handler
  (e.g. Codey's mentor-handler: consumes `mentor`, may produce only `mentor-reply` —
  cannot send the same role it consumes).
- **`mentor-reply` ingestion on Echo is finding-emission-only** — Stage-B parses → emits
  `ForensicFinding[]` → `capture()`. MUST NOT call `spawnStageA`, `deliverToMentee`,
  scheduler enqueue, or Threadline send. Import-surface lint enforces.
- **Every drop path writes an audit row** (silent drops make Stage-B forensics painful).
- Every received agent message (routed OR dropped) logged to `state/a2a-received.jsonl`
  (append-only).

### Anti-loop infra: structural, not just rules

1. **One outbound producer per `role`** + **role-handler allowlist** (Codey's sharpening).
   Each role-handler is constructed with an explicit allowed-outbound-roles list and
   `sendAgentMessage` refuses any role not in that list at runtime. **Capability-style
   enforcement** (round-2 adversarial F4 closure — picked over transitive-import-lint
   because it's structurally stronger): the reply-ingestion module receives a
   *capability handle* (`{capture: (findings) => void}`) — it does NOT have access to
   `spawnStageA`, `deliverToMentee`, scheduler, or Threadline at all. Future transitive
   imports can't bypass this because the symbols aren't reachable from the handle.
   Backup: dependency-cruiser lint (`forbidden: { from: 'mentor-reply-ingestion',
   to: ['scheduler', 'threadline', 'deliverToMentee', 'spawnStageA'] }`) catches any
   regression where someone adds an import bypassing the capability shape.
2. **Per-source role-acceptance matrix** (round-2 adversarial F6 closure). The accept-list
   is `{fromAgent: allowed-incoming-roles[]}`, NOT a flat per-recipient set. Echo's
   recipient handler for example: `{ 'instar-codey': ['mentor-reply'] }` — a compromised
   Codey sending `role: 'notify'` or `'coord'` to Echo's mentor-bot is dropped as
   `agent-marker-role-not-allowed-from-source`. Scoped admission.
3. **Cycle-detection keyed precisely** (Codey's refinement + round-2 F3 reinforcement):
   the detection key is `(fromBotId, toBotId, topicId, role, corr)` — and since `corr`
   is now REQUIRED in the marker (see §marker schema), the key never collapses. Default
   window 5s, configurable. Trips → require explicit `cycleOk: true` parameter or refuse
   with a `degradation` event.
4. **Round-trip audit ledger.** Sent + received ledgers include role, ids, `corr`
   correlation chains, bot/topic, and result. Stage-B / future debugging can prove there
   is no role→reply→role path within a single tick boundary. **Every drop path also
   writes** (no silent drops).
5. **`mentor-reply` ingestion on Echo is finding-emission-only** (Codey's explicit
   invariant): MUST NOT call `spawnStageA`, `deliverToMentee`, scheduler enqueue, or
   Threadline send. Enforced via capability-handle (point 1 above); the module
   *literally cannot reach* those symbols. Only outbound effect: `capture({findings})`.

### Config

New `agentTelegram` section in `.instar/config.json`:
```json
"agentTelegram": {
  "knownAgents": {
    "echo":        { "botId": "echo-mentor-bot-id" },
    "instar-codey":{ "botId": "codey-bot-id" }
  },
  "cycleDetectionWindowMs": 5000,
  "auditRetentionDays": 30
}
```

Per-recipient bot config (sender-side) lives under the consumer's section (e.g.
`mentor.codeyBot = {token, topicId}` — see Fix 2b).

## Fix 2b — Mentor consumes the primitive

- **Echo mints a dedicated mentor bot via @BotFather** (per Justin's choice C). Token
  stored in Echo's config under `mentor.botToken` (Secret-Drop-collected — never via chat
  paste).
- **Codey accepts the mentor bot** as a known agent in his `agentTelegram.knownAgents`
  allowlist, and routes any received `[a2a:role=mentor]` to a new "mentor inbox" topic
  (the dedicated Mentor session topic). The role-handler injects the message body
  (post-marker-strip) as a user prompt into Codey's mentor-session.
- **Codey's reply** goes back via `sendAgentMessage` with `role=mentor-reply` to Echo's
  mentor bot. Echo's mentor bot receives it; Echo's recipient handler routes to Stage-B.
- **Stage-B reply ingestion is finding-emission-only** — capture() only, no path to
  spawnStageA or another deliverToMentee. Unit-tested by an assertion: a `mentor-reply`
  received → next tick still defers (no implicit recurrence).
- **`deliverToMentee` (Echo-side) is replaced** by a thin wrapper around `sendAgentMessage`.
  The file-based mentor-outbox is retired (legacy artifact cleanup in migration).

### What this means for the mentor's Stage A

Stage A drives Codey "as a user would" — via Telegram, in the dedicated mentor topic,
through the primitive. Codey's mentor-handler processes the prompt the same way it would
process any user message (the test of his behavior under user-like interaction). The
identity is honest (it's Echo's mentor bot, not a Justin impersonation), but the
*interaction shape* is user-level, which is what the wild-behavior test needs.

### Implementation surface — what round-2 convergence flagged

The substrate change exposed real surface gaps in the existing TelegramAdapter. All five
need to land as part of this PR:

1. **Multi-instance state-file isolation (round-2 integration F1 — BLOCKING).**
   `TelegramAdapter` constructor writes to fixed `stateDir`-relative paths
   (`topic-session-registry.json`, `telegram-messages.jsonl`, `telegram-poll-offset.json`,
   `state/attention-items.json`). Two adapters sharing one `stateDir` clobber each
   other's offset/registry; `poll()`'s cross-token detection (`OFFSET_RANGE_THRESHOLD`)
   fires continuously. **Required:** add a constructor `subDir?: string` param;
   non-primary adapters get a namespaced sub-stateDir (e.g.
   `{stateDir}/agent-telegram/mentor-bot/`) for ALL state files. Primary bot's behavior
   unchanged (omit `subDir`).
2. **Lifeline-topic auto-creation guard (round-2 integration F1 cont'd).**
   `ensureLifelineTopic()` runs unconditionally on `start()`. Add a constructor
   `suppressLifelineAutoCreate?: boolean` (default false for primary; true for non-primary
   adapters like the mentor-bot) to prevent the mentor-bot creating a second Lifeline.
3. **Handler-chain primitive (round-2 lessons F1 + integration F2 — BLOCKING).**
   `TelegramAdapter.onMessage(handler)` is a *single-slot setter* (`this.handler = handler`
   at line ~1592, NOT line 1327 — corrected from the prior draft's bad cite). The spec's
   "agent-handler runs BEFORE normal user routing" is unimplementable as-stated. **Chosen
   resolution:** wrap at the existing registration site in `src/commands/server.ts`
   (~line 3038): the wrapper is `agentMessageHandler` first; if it returns `{handled:true}`,
   stop; else fall through to the existing user-routing handler. This avoids introducing
   a new chain API on the adapter (smaller blast radius) and keeps the precedence
   structural (the wrapper IS the only registered handler). A wiring-integrity test
   asserts the wrapper fires before the user-routing handler on a marker-bearing message.
4. **Outstanding-prompt tick-refusal (round-2 adversarial F7 + F8 — BLOCKING ping-pong).**
   The mentor-tick interval is 15min; if a single round-trip takes longer, the next tick
   firing while the prior is in flight would re-send and rebuild the ping-pong slower.
   Required: an `outstandingPrompts: Map<corr, {sentAt, mentee}>` per mentee. Tick refuses
   to send a new prompt while any prompt is outstanding within `mentor.replyTimeoutMs`
   (default 20min, ≥ tick interval). Reason: `prior-prompt-in-flight`. On timeout expiry
   without a reply → `DegradationReporter` event `mentor.reply-orphaned` + one Attention
   entry (deduped per `corr` per day). The same primitive solves vector F7 (silent
   reply-loss).
5. **Token-leak scrubbing in error paths (round-2 adversarial F5).** `mentor.botToken`
   is a high-value secret. Telegram 401s sometimes echo the token in response bodies; any
   exception path that logs the response could leak. Required: `sendAgentMessage` wraps
   adapter calls and runs a regex scrub of the known token value over any
   exception/log/`DegradationReporter` surface before it leaves the module. Add a
   `mentor.botToken.rotatedAt` field + a `POST /mentor/bot-setup/rotate` flow (Secret-
   Drop's existing one-time-URL confirmation is sufficient — no new "OOB-confirmed"
   sub-feature; round-2 integration F4 correction).

## Fix 3 — Quota-aware budget + notification (unchanged from prior draft)

- **Remove** `dailySpendCapUsd` from config defaults; add `mentor.quotaCeiling` (default
  `elevated`), wire `budgetOk` to `QuotaTracker.canRunJob('low')` + run-count backstop.
- **Quota null/stale → fail-closed** (`reason: quota-unknown`); override the default
  fail-open.
- **Token-spend ceiling — STAGE-B ONLY today** (`mentor.stageBTokenCeiling`, default
  200_000) summed via prefix-match `mentor-stage-b::%` on
  `TokenLedger.byAttributionKey({sinceMs})` (or thin `byComponent('mentor-stage-b')`
  helper). **Honest scope downgrade (round-2 integration F3 — BLOCKING).** Stage-B
  goes via `intelligence.evaluate` → `recordEvent` → attributed `mentor-stage-b::*`.
  Stage-A is a spawned Claude-CLI session whose tokens reach the ledger via JSONL
  scan and fall under `unknown::pre-attribution` (`TokenLedger.ts:404-407`, explicit).
  Stage-A spend is **invisible to this ceiling**. The honest name reflects that; a separate
  PR will bring Stage-A under the same cap via a session-name-prefix attribution resolver.
  <!-- tracked: topic-13435 --> Don't claim coverage we don't have.
- **Trip-EPISODE state machine** (not day-bucket); alerts on `ok→tripped` AND
  `tripped→ok`; file-backed persistence at `state/mentor-budget-notifications.json` via
  `SafeFsExecutor.atomicWriteJsonSync`; CAS single-writer; corrupt-state-file recovery
  with degradation event; optional `budgetReminderHours` long-trip reminder (default off).
- **Mentor budget is Echo-side primarily** (Codey's surface check: his instance reports
  `quotaTracking:false`). The budget gates **Echo's mentor-tick sending** — Echo's tokens
  are the spend that needs capping. Codey's replies go through his normal handling on his
  side; this fix does not require any quota wiring on Codey's side.

## Scope

- **In:** `AgentTelegramComms` primitive (sender + recipient + marker + anti-loop infra +
  audit ledgers + config), mentor as its first consumer (mentor-bot + Stage-A/Stage-B
  rewiring + retire file-outbox), Fix 3 quota-budget. (Fix 1 idle-probe REMOVED — Justin
  user-fidelity correction; mentor cadence is Echo-side only.)
- **Out:** HMAC-signed markers (v2 if cross-machine trust matters); multi-mentee fan-out;
  Threadline-relay-based mentor delivery (intentionally rejected — Telegram is the test
  substrate); any mentee-state probing (intentionally rejected — users don't probe).

## Migration parity

- **Config (additive):** `agentTelegram` section (new), `mentor.botToken`,
  `mentor.menteeBotId`, `mentor.menteeTopicId`, `mentor.quotaCeiling`,
  `mentor.stageBTokenCeiling` (renamed from `dailyTokenCeiling` per honest-scope
  downgrade), `mentor.budgetReminderHours`, `mentor.replyTimeoutMs` added via
  `ConfigDefaults.getMigrationDefaults()` + `applyDefaults` (existence-checked).
  (`mentor.menteeServerUrl` REMOVED — Fix 1 idle-probe deleted.)
- **Config (removal — NOT silent, dedicated migration method).** `applyDefaults` is
  value-patching only and cannot remove fields (round-2 integration F5). Add a dedicated
  `migrateRetireDeadMentorConfig` method on `PostUpdateMigrator` (modeled on
  `migrateLegacyMaxSessions` at line ~3961) with a marker in `_instar_migrations`,
  existence-checked, idempotent. Deletes `mentor.dailySpendCapUsd` (silent if default
  `0.5`); if non-default, emit ONE Attention entry explaining the field was decorative
  (subscription, no per-token charge) and the replacement is `mentor.stageBTokenCeiling`.
- **Retire the file-outbox (dedicated method via SafeFsExecutor).** No existing migration
  does fs-cleanup (round-2 integration F5). Add `migrateRetireMentorOutbox` on
  `PostUpdateMigrator` — marker in `_instar_migrations`, existence-check, route through
  `SafeFsExecutor.safeRmSync` (the project's destructive-fs funnel), audit-log entry,
  emit one Attention entry if any files were present. Deletes
  `{stateDir}/mentor-outbox/*` on first run after this update lands. Idempotent.
- **Codey bot allowlist bootstrapping.** Echo-side: `mentor.botToken` is Secret-Drop-
  collected during a `/mentor/bot-setup` one-time command. **Use Secret-Drop's existing
  one-time-URL + Telegram confirmation flow** — no new "OOB-confirmed" sub-feature
  (round-2 integration F4 correction: OOB-confirmed wasn't an existing pattern; Secret-
  Drop's confirmation is sufficient for a bot token). Codey-side: he adds Echo's
  mentor-bot ID to his `agentTelegram.knownAgents` allowlist as part of his side's PR.
- **Routes.** `POST /mentor/bot-setup` and `POST /mentor/bot-setup/rotate` are on Echo
  and **inherit the existing `/mentor` prefix classification** in `CapabilityIndex.ts`
  (verified line 493 — no CapabilityIndex change needed; round-2 integration F6
  correction to the prior draft's claim). Echo adds a CLAUDE.md template entry per
  the Agent Awareness Standard (curl example + proactive trigger: "when user says
  'set up the mentor bot'"). (`GET /idle` on Codey's server REMOVED.)

## Testing

1. **Unit — primitive marker parsing:** valid markers parse (incl. required `corr` + `ts`);
   malformed markers (missing fields incl. `corr`/`ts`, wrong version, charset violations,
   extra fields) reject as `agent-marker-malformed`; `|now-ts| > skewWindowMs` rejects as
   `agent-marker-stale-or-future`; unknown sender → drop (not route to user handler).
2. **Unit — user-spoof defense (round-2 adversarial F1):** a `Message` with a valid
   marker prefix but `from.is_bot !== true` and no `sender_chat` → DROP as
   `agent-marker-spoofed-by-user`. Critical: assert this even when `from.id` matches a
   value in the allowlist (e.g. a human user with the same numeric id as an allowlisted
   bot would still drop because `is_bot:false`).
3. **Unit — per-source role-acceptance (round-2 adversarial F6):** Echo's recipient
   configured with `{ 'instar-codey': ['mentor-reply'] }`. A message with valid marker but
   `from=instar-codey, role=notify` → DROP as `agent-marker-role-not-allowed-from-source`,
   even if `notify` is registered for ANOTHER source.
4. **Unit — anti-loop infra:**
   - **Capability-handle structural** (round-2 adversarial F4): the reply-ingestion
     module's constructor takes only `{capture}` — assert via TypeScript types that the
     module CANNOT reference `spawnStageA`/`deliverToMentee`/scheduler/Threadline
     (compile-time invariant). Plus a dependency-cruiser rule as backup.
   - Cycle-detection: two sends to the same `(fromBotId,toBotId,topicId,role,corr)` within
     5s without `cycleOk:true` → refused + degradation event. Unrelated `corr` ≠
     conflict.
   - Round-trip ledger: send + receive both write their audit rows; correlation chain
     reconstructable via `corr`; NO tokens/secrets in the row.
5. **Unit — Fix 3 budget:** as prior draft (trip-episode state machine, quota null
   fail-closed, CAS persistence, corrupt-recovery). Add: assert the ceiling captures only
   `mentor-stage-b::%` (Stage-B); spawn a fake Stage-A JSONL event with
   `unknown::pre-attribution` and assert it does NOT count against the ceiling — the
   honest-scope downgrade is testable.
7. **Unit — outstanding-prompt tick refusal (round-2 adversarial F8 — the rebuilt
   ping-pong):** tick fires; sends prompt with `corr=A`; before reply, next tick fires →
   refused with `reason: prior-prompt-in-flight`. Then 21min elapse (> default 20min
   timeout) → `mentor.reply-orphaned` degradation event + Attention entry; next tick
   allowed.
8. **Unit — multi-instance TelegramAdapter state isolation (round-2 integration F1):**
   construct two `TelegramAdapter` instances with the same `stateDir` but different
   `subDir`. Each adapter's poll-offset / topic-registry / messages-jsonl writes go to
   ITS OWN namespace; no cross-clobber. Also: with `suppressLifelineAutoCreate:true`,
   `ensureLifelineTopic` doesn't run.
9. **Unit — token-leak scrub (round-2 adversarial F5):** simulate a Telegram 401 whose
   error body echoes the bot token; assert no log/exception/`DegradationReporter` event
   leaving the module contains the token value.
10. **Integration — Echo-side mentor consumer:** mock `TelegramAdapter` sends via
    `sendAgentMessage`; assert marker formed correctly (with `corr` + `ts`), audit
    written; simulate `mentor-reply` received → Stage-B parser invoked; assert next tick
    still defers (no recurrence). Plus: assert the agent-handler wrapper fires BEFORE
    the user-routing handler on a marker-bearing message (wiring-integrity for the
    handler-chain wrapping at the registration site).
11. **Integration — bidirectional contract (the #425 gap-closer):** fixture test where
    a "Codey-like" recipient (using the same exported primitive) ingests Echo's
    sendAgentMessage write, runs the role-handler, writes a reply via
    `sendAgentMessage(role=mentor-reply)`, and Echo's Stage-B parser handles it. Real
    round-trip through the primitive on both sides.
12. **Wiring-integrity:** production wiring of `budget` / `sendAgentMessage` / the
    agent-handler wrapper is non-null + non-no-op; dependency-cruiser rule passes on the
    actual codebase.
13. **End-to-end — supervised live cycle** (the actual test):
    - Echo's mentor-bot active in a dedicated Mentor topic in Codey's setup.
    - Echo sends one tagged mentor message on schedule (no mentee-state probe) → Codey's
      recipient handler routes to mentor handler → injects as user prompt → Codey replies
      via `sendAgentMessage(role=mentor-reply)`.
    - Echo receives the reply → Stage-B emits findings.
    - Next tick defers (no auto-recurrence) — outstanding-prompts check + budget gate.
    - Capture token-ledger spend (Stage-B attribution + Stage-A unknown::pre-attribution
      separately), ledger audit trail, any degradation events.
    - Assert no second Lifeline topic appears in the chat (multi-instance hygiene).

## Co-design with Codey

**Round 1 (file-based) — superseded** by Justin's substrate correction.

**Round 2 (Telegram-based) — CLOSED** (Threadline thread 14629926, 2026-05-27). Codey
endorsed the substrate correction verbatim ("Telegram is the right substrate for this
test; the previous file outbox made the transport easier but weakened the actual behavior
being tested") AND **verified his own live capability surface** before answering (v1.3.15,
Telegram bidirectional, Threadline enabled, mentor endpoints present, `quotaTracking:false`
on his instance — applying [[feedback_report_verified_not_intended_behavior]]).

**Round 3 (Justin user-fidelity correction, 2026-05-27): `/idle` WITHDRAWN.** The whole
mentee-state-probe is removed (users don't probe before sending). Codey is relieved of the
`/idle` endpoint ask. His remaining side: the recipient handler + `sendAgentMessage` + the
`agentTelegram.knownAgents` allowlist. A short Threadline note will tell him `/idle` is off
the table (good news — less for him to build).

Codey's substantive refinements (all folded above; the /idle one is now moot):
1. ~~**/idle**~~ — WITHDRAWN (Justin user-fidelity correction). The endpoint is not built.
2. **Recipient handler** — strict malformed-marker drop (security event, NEVER fall
   through to user); explicit per-decision audit row; processed-id idempotency ledger
   against Telegram retries / adapter restarts.
3. **Sender** — make generic (not mentor-specific); caller passes allowed-roles list at
   construction; return `a2aId` alongside `sentMessageId`; full audit-row schema
   (no secrets in ledgers).
4. **Marker schema** — constrain field-value charset to `[A-Za-z0-9._:-]+` + integer for
   `v` (deterministic parsing, avoids invisible/escaping cases); add **visible `corr=`**
   field so Telegram chat history alone reconstructs the round-trip when ledgers
   unavailable.
5. **Anti-loop invariants** — agent-origin messages suppress courtesy/ack BEFORE normal
   user routing sees them; role-handler explicit allowed-outbound-roles list (cannot send
   the role it consumes); `mentor-reply` ingestion on Echo MUST be finding-emission-only
   (no Stage A, no `deliverToMentee`, no scheduler enqueue, no Threadline send); cycle-
   detection key is `(fromBotId, toBotId, topicId, role, corr)`, not just bot+topic;
   every drop path writes an audit row.

**Implementation note Codey raised:** the Codey-side PR should land in the **instar source
package** (the upstream that produces the shadow-install), NOT as a hand-edit under
`.instar/shadow-install`. The primitive ships as part of instar; per-agent config
(agentTelegram allowlist + mentor.botToken) is the only per-agent piece.

**Quota-budget on Codey's side (Codey's surface check):** his instance reports
`quotaTracking:false`, so Fix 3 (quota-aware budget) is primarily an **Echo-side**
mechanism — Codey doesn't gate his own work against quota for this loop. The mentor
budget gates Echo's *sending* (Echo's tokens are the spend); Codey's responses go through
his own normal handling. Documented in §Fix 3 below.

## Honesty / lessons applied

- Every claim about an existing surface cites the code I read (TelegramAdapter.onMessage
  line **1592** — corrected from prior draft's bad cite of 1327, caught by round-2
  reviewers; sendToTopic widely used; QuotaTracker.canRunJob from prior verification;
  TokenLedger.byAttributionKey/attribution_key shape from prior verification — including
  the explicit `unknown::pre-attribution` for JSONL-source events at TokenLedger.ts:404-407
  which forces the honest Stage-B-only scope of the spend ceiling). The substrate-vs-
  discipline error that bit this morning is recorded ([[feedback_report_verified_not_
  intended_behavior]] + [[feedback_fix_at_the_right_level]]) — both surfaced from
  Justin pushback today, both now durable.
- The convergence rounds on the file-based design caught everything that mattered about
  that design EXCEPT whether the design's substrate was right — that's an instructive
  limit of reviewer review (reviewers ask "is this sound?", not "is this framing
  correct?"). Future specs must surface substrate choices explicitly so the framing is
  reviewable, not assumed.
