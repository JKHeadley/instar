---
title: Agent-to-Agent Telegram comms primitive + Mentor live-readiness (its first consumer)
owning-layer: messaging (new primitive) + scheduler/server (mentor consumer)
status: draft
review-convergence: false
review-iterations: 0
co-designer: instar-codey (pending — recipient-side detection + anti-loop handler)
approved: false
supersedes-rounds: 2 prior convergence rounds on file-based mentor-outbox design (committed but re-architected after Justin substrate correction, topic 13435, 2026-05-27)
supervision: tier1
---

# Agent-to-Agent Telegram comms primitive + Mentor live-readiness

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

### Gap 1 — `isMenteeBusy()` is a stub that's not about the mentee at all

`AgentServer.ts:~651`: `isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0`.
Tagged `<!-- tracked: topic-13435 -->`. Checks Echo's own sessions; almost always true →
safe window never opens → mentor effectively never runs.

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

## Fix 1 — Real Codey-idle signal (replaces the system-busy stub)

Replace `isMenteeBusy` with a **mentee-specific** idle check via a new unauthenticated
`GET /idle` endpoint Codey ships on his server (port 4044). `/sessions` is Bearer-authed
AND has no `activelyWorking` field, so a fresh endpoint is needed.

`/idle` returns:
```json
{ "schemaVersion": 1, "idle": true, "bootId": "uuid-set-at-process-start",
  "uptimeSec": 12345, "activeSessions": 0, "ts": "ISO-8601" }
```

Echo-side:
- Probe `{mentor.menteeServerUrl}/idle` with 750ms timeout.
- **Fail-closed on every ambiguous outcome**: non-2xx, network/timeout, JSON-parse failure,
  unrecognized schemaVersion, missing required fields, `idle !== true` → busy.
- **Liveness-warmup**: `idle:true` but `uptimeSec < minIntervalMs/1000` → defer one cycle
  (don't pile onto a recovering Codey).
- Persistent failure (≥3 consecutive) → `DegradationReporter` event `mentor.menteeProbe`.
- Reasons split: `mentee-busy` vs `min-interval-not-elapsed` (distinct strings).

## Fix 2a — Agent-to-Agent Telegram Comms primitive (new infra)

**Module:** `src/messaging/AgentTelegramComms.ts` (new) — generic primitive, mentor-agnostic.

### The marker

Every agent-to-agent message carries a structured, visible prefix in the message body:

```
[a2a:from=<senderAgent> to=<recipientAgent> role=<role> id=<stable-uuid> v=1]

<message body>
```

- **Visible in chat** — humans can audit at a glance (a real chat-log forensic property,
  not a hidden metadata field).
- **Parseable** — regex `^\[a2a:from=(\S+) to=(\S+) role=(\S+) id=(\S+) v=(\d+)\]\n\n`.
- **Versioned** (`v=1`) — schema bumps are explicit.
- **No HMAC v1** — recipient trusts the marker if the sender Telegram bot identity is in
  the recipient's known-agents allowlist (the structural identity check is the Telegram bot
  ID, not the marker text). HMAC-signed markers deferred to v2 if cross-machine trust
  becomes a concern.
- **Roles defined**: `mentor`, `mentor-reply`, `coord`, `coord-reply`, `notify` (extensible).

### Sender side

```ts
sendAgentMessage({
  fromAgent: 'echo',
  toAgent: 'instar-codey',
  toBotToken: cfg.codey.mentorBotToken,   // the recipient's mentor-bot token
  toTopicId: cfg.codey.mentorTopicId,     // the dedicated topic in recipient's setup
  role: 'mentor',
  message: '<the prompt>',
  correlationId?: 'optional-existing-id-for-reply-threading',
}): Promise<{ ok: boolean; sentMessageId?: string; reason?: string }>
```

- Instantiates (or reuses) a `TelegramAdapter` for the recipient's bot.
- Prepends the marker; calls `sendToTopic(toTopicId, marker+body)`.
- Returns `{ok, sentMessageId}` so consumers can correlate.
- Logs every send to an audit ledger (`state/a2a-sent.jsonl`) — append-only.

### Recipient side

A new incoming-message handler registered with `TelegramAdapter.onMessage`:

```ts
agentMessageHandler(rawMsg): { handled: boolean; routedTo?: string }
```

- Parses the marker. If absent → not an agent message; fall through to normal user handler.
- If present and `from` is in the known-agents allowlist (`config.agentTelegram.knownAgents`)
  AND the sender bot ID matches → route to the appropriate handler (`role` → handler map).
- **If marker present but `from` not allowlisted OR bot ID mismatch**: log as
  `agent-marker-unknown` and drop (NEVER deliver to the normal user-message path — spoofing
  defense; an unknown party adding a marker doesn't get user-level processing).
- **Anti-loop discipline (the heart of the primitive)**:
  - Agent-origin messages NEVER auto-trigger courtesy replies. The role-handler is the
    only producer of any outgoing message in response.
  - If the role-handler does produce a reply, it routes through `sendAgentMessage` with
    `role=<original>-reply`, carrying the original `id` as `correlationId`. Replies are
    marked, traceable, and visible.
  - **A reply received (e.g. `mentor-reply`) NEVER triggers another `mentor` send.**
    Outgoing mentor messages come only from the scheduled mentor cycle. Same for any
    role-pair. Compile-time guard: the role-handler module's import surface lint forbids
    `sendAgentMessage(role='X')` if it also reads `role='X-reply'` (no closed-loop within
    one module).
- Every received agent message logged to `state/a2a-received.jsonl` (append-only audit).

### Anti-loop infra: structural, not just rules

1. **One outbound producer per `role`.** Each `role` has exactly one module that may send
   it (`mentor` is sent only by the mentor tick; `mentor-reply` only by Codey's mentor
   handler). Import-surface lint enforces.
2. **Cycle-detection in flight.** If `sendAgentMessage` sees a recipient bot-id+topic that
   matches an inflight conversation where the local agent received from that bot in the
   last N seconds (default 5), it requires an explicit `cycle-ok: true` parameter or
   refuses with a degradation event.
3. **Round-trip audit ledger.** Both ledgers (sent + received) include role, ids, and
   correlation chains. Stage-B / future debugging can prove there is no role→reply→role
   path within a single tick boundary.

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

## Fix 3 — Quota-aware budget + notification (unchanged from prior draft)

- **Remove** `dailySpendCapUsd` from config defaults; add `mentor.quotaCeiling` (default
  `elevated`), wire `budgetOk` to `QuotaTracker.canRunJob('low')` + run-count backstop.
- **Quota null/stale → fail-closed** (`reason: quota-unknown`); override the default
  fail-open.
- **Token-spend ceiling** (`mentor.dailyTokenCeiling`, default 200_000) summed via
  prefix-match `mentor-stage-b::%` on `TokenLedger.byAttributionKey({sinceMs})`.
- **Trip-EPISODE state machine** (not day-bucket); alerts on `ok→tripped` AND
  `tripped→ok`; file-backed persistence at `state/mentor-budget-notifications.json` via
  `SafeFsExecutor.atomicWriteJsonSync`; CAS single-writer; corrupt-state-file recovery
  with degradation event; optional `budgetReminderHours` long-trip reminder (default off).

## Scope

- **In:** `AgentTelegramComms` primitive (sender + recipient + marker + anti-loop infra +
  audit ledgers + config), mentor as its first consumer (mentor-bot + Stage-A/Stage-B
  rewiring + retire file-outbox), Fix 1 idle signal, Fix 3 quota-budget.
- **Out:** HMAC-signed markers (v2 if cross-machine trust matters); multi-mentee fan-out;
  Threadline-relay-based mentor delivery (intentionally rejected — Telegram is the test
  substrate); a general "agent presence" service beyond the per-probe `/idle` (separate
  concern).

## Migration parity

- **Config (additive):** `agentTelegram` section (new), `mentor.botToken`,
  `mentor.menteeServerUrl`, `mentor.menteeBotId`, `mentor.menteeTopicId`,
  `mentor.quotaCeiling`, `mentor.dailyTokenCeiling`, `mentor.budgetReminderHours` added
  via `ConfigDefaults.getMigrationDefaults()` + `applyDefaults` (existence-checked).
- **Config (removal — NOT silent).** `migrateConfig` deletes `mentor.dailySpendCapUsd`
  (silent if default `0.5`); if non-default, emit ONE Attention entry explaining the
  field was decorative (subscription, no per-token charge) and the replacement is
  `mentor.dailyTokenCeiling`.
- **Retire the file-outbox.** `migrateConfig` deletes `{stateDir}/mentor-outbox/*` on the
  first run after this update lands (the legacy outbox is now dead state). Idempotent.
  An Attention entry notes the cleanup if any files were present.
- **Codey bot allowlist bootstrapping.** Echo-side: `mentor.botToken` is Secret-Drop-
  collected during a `/mentor/bot-setup` one-time command (interactive, OOB-confirmed) —
  never via chat paste. Codey-side: he adds Echo's mentor-bot ID to his
  `agentTelegram.knownAgents` allowlist as part of his side's PR.
- **Routes.** Two new routes (`GET /idle` on Codey's server; `POST /mentor/bot-setup` on
  Echo). Both get CapabilityIndex prefix classification + CLAUDE.md template entry per
  the Agent Awareness Standard.

## Testing

1. **Unit — primitive marker parsing:** valid markers parse; malformed markers
   (missing fields, wrong version, extra fields) reject; unknown sender → drop (not
   route to user handler); spoofed `from` but wrong bot ID → drop + log.
2. **Unit — anti-loop infra:**
   - Role-handler import-surface lint: a module that registers as `mentor` handler MUST
     NOT import `sendAgentMessage` with `role: 'mentor'` (only `mentor-reply`).
   - Cycle-detection: two sends to the same recipient within 5s without `cycle-ok:true`
     → refused + degradation event.
   - Round-trip ledger: send + receive both write their audit rows; correlation chain
     reconstructable.
3. **Unit — Fix 1 idle:** as prior draft (fail-closed coverage on every ambiguous
   outcome including 200+missing-fields; liveness-warmup; persistent-failure degradation).
4. **Unit — Fix 3 budget:** as prior draft (trip-episode state machine, quota null
   fail-closed, prefix-match summation, CAS persistence, corrupt-recovery).
5. **Integration — Echo-side mentor consumer:** mock `TelegramAdapter` sends via
   `sendAgentMessage`; assert marker formed correctly, audit written; simulate
   `mentor-reply` received → Stage-B parser invoked; assert next tick still defers (no
   recurrence). This closes the [[project_jobs_load_fix_layered]] test-gap pattern.
6. **Wiring-integrity:** production wiring of `getMenteeIdle` / `budget` /
   `sendAgentMessage` is non-null + non-no-op; arch-test on import surfaces.
7. **End-to-end — supervised live cycle** (the actual test):
   - Echo's mentor-bot active in a dedicated Mentor topic in Codey's setup.
   - `/idle` probe succeeds → idle:true.
   - Echo sends one tagged mentor message → Codey's recipient handler routes to mentor
     handler → injects as user prompt → Codey replies via `sendAgentMessage(role=mentor-reply)`.
   - Echo receives the reply → Stage-B emits findings.
   - Next tick defers (no auto-recurrence). Capture token-ledger spend + ledger audit
     trail + any degradation events.

## Co-design with Codey (NEW round, recipient-side substrate is now Telegram)

Round 1 (prior file-based design) is superseded by this redesign. New asks for Codey:

1. Add `agentTelegram.knownAgents` allowlist + `/idle` endpoint on his server.
2. Implement the recipient-side `agentMessageHandler` for incoming Telegram messages with
   the `[a2a:...]` marker — route `role=mentor` to a new mentor-message handler that
   injects into his mentor-session as a user prompt; route `mentor-reply` to nothing on
   his side (he's not the recipient of replies; Echo is).
3. Implement `sendAgentMessage` on his side so his mentor-handler can write the `mentor-
   reply` back to Echo's mentor bot.
4. Confirm or adjust the marker schema (`[a2a:from=… to=… role=… id=… v=1]`).
5. Confirm the anti-loop infra invariants (one outbound producer per role; cycle-
   detection; audit ledgers).

Sent to Codey on a fresh Threadline thread + view link after Justin's nod on this draft.

## Honesty / lessons applied

- Every claim about an existing surface cites the code I read (TelegramAdapter.onMessage
  line 1327; sendToTopic widely used; QuotaTracker.canRunJob from prior verification;
  TokenLedger.byAttributionKey/attribution_key shape from prior verification). The
  substrate-vs-discipline error that bit this morning is recorded ([[feedback_report_
  verified_not_intended_behavior]] applies + adjacent lesson on level-of-fix selection).
- The convergence rounds on the file-based design caught everything that mattered about
  that design EXCEPT whether the design's substrate was right — that's an instructive
  limit of reviewer review (reviewers ask "is this sound?", not "is this framing
  correct?"). Future specs must surface substrate choices explicitly so the framing is
  reviewable, not assumed.
