---
title: Mentor live-readiness — real idle signal, mentee-side pickup, quota-aware budget
owning-layer: scheduler + server (mentor)
status: draft
supervision: tier1
---

# Mentor live-readiness

## Summary

The mentor system ships fully built but with three placeholders that block a real live test
against Codey. All three were surfaced during the 2026-05-27 dry-run live-validation phase
(topic 13435 — Justin caught two; the third I verified before claiming a live test would
work). Fixing all three is the prerequisite for one supervised live cycle against Codey, and
then for unattended live operation.

## The three gaps

### Gap 1 — `isMenteeBusy()` is a stub that's not about the mentee at all

`AgentServer.ts:~651`:
```ts
isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0,
```

Tagged in code with `<!-- tracked: topic-13435 -->` ("refined at live validation"). It checks
**Echo's own** running-session count, not Codey's state. Echo almost always has running
sessions → `isMenteeBusy()` is almost always true → `safeWindowOpen` is almost never true →
**the mentor effectively never runs**.

### Gap 2 — `deliverToMentee` is write-only (no Codey-side pickup)

`AgentServer.ts:~671-678`: `deliverToMentee` correctly appends a JSON line to
`{stateDir}/mentor-outbox/<framework>.jsonl`. The persist-only-no-spawn shape is the
deliberate **structural fix for the cross-agent spawn loop** ([[bug_cross_agent_ack_spawn_loop]]).
But **nothing on Codey's side reads that outbox** — verified by grepping the shipped dist for
mentor-outbox readers (one writer, zero readers). A live test today would write a file Codey
never sees. The mentee-side pickup is the missing piece — and it's Codey's side, so co-design.

### Gap 3 — Budget is dollar-denominated on a token-subscription, unenforced, silent on trip

`AgentServer.ts:~656-664`: `budgetOk` checks `mentorRunsToday < cfg.maxRoundsPerDay`
(24/day **run-count**). `cfg.dailySpendCapUsd: 0.5` is configured in
`MentorOnboardingRunner.DEFAULT_MENTOR_CONFIG` and `ConfigDefaults.ts` but **read nowhere**
(dead field — verified by repo-wide grep). Worse, the unit is fundamentally wrong: Echo runs
on a Claude **subscription**, not pay-per-token API, so there is no per-token dollar charge to
cap. The real cost is **tokens against a rolling quota** (5-hour + weekly limits) — already
tracked by `QuotaTracker` (`canRunJob(priority)` → normal/elevated/critical/shutdown) and
`TokenLedger` (with `attribution: { component: 'mentor-stage-b' }` already set). And nothing
notifies Justin when the cap (round or otherwise) trips.

## Fix

### Fix 1 — Real Codey-idle signal (replaces the system-busy stub)

Replace `isMenteeBusy` with a **mentee-specific** idle check that queries the mentee agent's
own server:

- Resolve mentee endpoint from a new `mentor.menteeServerUrl` config (defaults to
  `http://localhost:4044` for `codex-cli`, the co-located Codey instance).
- Probe `GET {menteeServerUrl}/sessions` (or a dedicated `/idle` endpoint if Codey adds one as
  part of his side of the co-design) with a 500ms timeout.
- Idle = no session with `activelyWorking=true` for that mentee. On probe failure (network,
  timeout, 4xx/5xx), **fail-closed: treat as busy** — never run the mentor blindly when
  Codey's state is unknown. Emit a degradation signal on persistent probe failure (so
  unresolvable mentee-unreachable surfaces, doesn't hide).
- The check is async; the runner pre-resolves it before assembling tick deps (the tick stays
  pure).

### Fix 2 — Mentee-side outbox pickup (Codey-designed, Threadline 5cc61bd7, 2026-05-27)

Keep the outbox-write exactly as is (the spawn-loop-safe shape is correct). Add a
**pull-based pickup** on Codey's side. Codey picked **option (a) — a scheduled poll job** —
explicitly because it survives restarts, session churn, and partial failures; correctness
matters more than the latency cost of supervised live-loop turnaround (~30–60s acceptable).

**Pull mechanism (Codey's side, his code).** `mentor-inbox-poll` agentmd job, runs ~every
minute. Reads append-only JSONL, keeps a **durable per-source byte-offset cursor**, processes
only complete newline-terminated records, uses a lock file so overlapping invocations cannot
double-deliver, and on injection delivers via the local server/session-injection surface
(Codey-side abstraction — intentionally *not* bound in the contract to a specific function
name, since the injection API is per-harness). On malformed-but-complete line → dead-letter
+ advance cursor; on incomplete trailing line → wait for next poll.

**Paths (stateDir-relative on each side — IMPORTANT: `{codeyStateDir}` is *Codey's* state
root, not Echo's, so Echo must write cross-agent into Codey's local state dir).**

| File | Owner | Purpose |
|------|-------|---------|
| `{codeyStateDir}/mentor-outbox/codex-cli.jsonl` | Echo writes / Codey reads | Inbound mentor prompts |
| `{codeyStateDir}/mentor-outbox/.cursors/codex-cli.cursor.json` | Codey | Durable byte-offset cursor |
| `{codeyStateDir}/mentor-outbox/codex-cli.deadletter.jsonl` | Codey | Malformed lines, audit |
| `{codeyStateDir}/mentor-outbox/codex-cli.delivery.jsonl` | Codey writes / Echo Stage-B reads | Per-injection audit row (written immediately after successful inject, BEFORE the reply) |
| `{codeyStateDir}/mentor-outbox/codex-cli.reply.jsonl` | Codey writes / Echo Stage-B reads | Per-prompt terminal outcome |

Echo resolves `{codeyStateDir}` from a new config `mentor.menteeStateDir` (default
`/Users/justin/Documents/Projects/instar-codey/.instar` for `codex-cli`). The contract stays
stateDir-relative; the absolute-path resolution is the only machine-specific shim.

**Audit pattern (Codey's preference, adopted).** The poller writes a **delivery row
immediately after successful injection** + the **reply row only after the session produces
the assistant response**. This lets Stage-B distinguish three states cleanly: *never picked
up* (no delivery row for this id) / *picked up, no reply yet* (delivery row, no reply row) /
*reply completed* (both rows). Stage-B matches on `correlationId` first, `requestId` second.

**Line schema — inbound prompt (Echo → Codey).**
```json
{
  "schemaVersion": 1,
  "id": "uuid-or-stable-id",
  "ts": "2026-05-27T18:25:18.831Z",
  "kind": "mentor.live.prompt",
  "from": { "agent": "echo", "role": "mentor" },
  "to": { "agent": "instar-codey", "framework": "codex-cli" },
  "threadId": "optional-mentor-thread-or-run-id",
  "correlationId": "stable-id-stage-b-uses-to-match-reply",
  "message": "prompt text",
  "replyRequired": true,
  "expiresAt": "optional-iso-ts (if absent, processed whenever seen)"
}
```
- `id` is REQUIRED (idempotency anchor).
- `correlationId` defaults to `id` if omitted; Stage-B matches it first.
- Echo MAY emit top-level `framework` as a compatibility alias during rollout; the canonical
  location is `to.framework`.
- `message` is the only prompt-content field; metadata is routing/audit, never executable
  instructions.
- `attachments` field is reserved for future use; for now, prompt is a plain string.

**Line schema — reply (Codey → Echo, terminal outcome).**
```json
{
  "schemaVersion": 1,
  "kind": "mentor.live.reply",
  "id": "uuid-for-this-reply-row",
  "requestId": "incoming-line-id",
  "correlationId": "incoming-correlation-id-or-id",
  "ts": "2026-05-27T18:26:05.000Z",
  "from": { "agent": "instar-codey", "framework": "codex-cli" },
  "to": { "agent": "echo", "role": "mentor" },
  "status": "ok",
  "message": "assistant reply text",
  "session": {
    "topicId": null,
    "sessionId": "optional-local-session-id",
    "delivery": "active-session"
  },
  "error": { "code": "no_active_session", "retryable": true }
}
```
- `status ∈ {ok, error, ignored, expired}`.
- `error` is present only for non-`ok` statuses; `message` remains user-safe.

**Anti-loop contract (Codey-asserted, baked into the spec — both sides comply).**

1. Echo writes files only. Codey reads files only for inbound mentor prompts. **No
   Threadline send, no agent spawn, no HTTP callback as part of the live loop.**
2. Codey replies by appending to the reply JSONL file only. Echo Stage-B reads that file;
   Echo MUST NOT treat a reply as a trigger to write a new prompt unless a human/supervisor
   explicitly starts a new mentor turn.
3. Every incoming row needs a stable `id`; Codey maintains a processed-id ledger (cursor +
   id check) so file rewrites, duplicate appends, and restarts do not re-inject.
4. Optional `expiresAt` for prompts whose staleness is unsafe; absence = process whenever
   seen.
5. `replyRequired` may be false for one-way deliveries; for the live-loop test, set true.
6. **Metadata is routing/audit only** — never prompt content. Only `message` is interpreted
   as prompt.
7. **One writer per file.** If multi-mentor lands later, one source file per writer (or
   append-locking).
8. Delivery + reply ledgers are append-only so Stage-B can reconstruct the run even on
   mid-turn crash.

**Echo-side responsibilities (this PR ships).** (i) Replace the per-tick `{ts,framework,message}`
write with the schemaVersion=1 record above (with `id` + `correlationId`). (ii) Write to
`{mentor.menteeStateDir}/mentor-outbox/codex-cli.jsonl` (cross-agent into Codey's state
dir). (iii) Publish a typed-contract export Stage-B uses to parse reply.jsonl. (iv) Add a
contract test that round-trips a written prompt + a hand-written reply through the parser.

**Codey-side responsibilities (Codey ships, separately).** The `mentor-inbox-poll` job,
cursor + lock + dead-letter, the local injection abstraction, the delivery + reply writers.
Both halves must land before the supervised live test. Coordinated through this spec's
shared contract.

### Fix 3 — Quota-aware budget + notification (replaces the dead dollar cap)

- **Remove** `dailySpendCapUsd` from config defaults; replace with `mentor.quotaCeiling`
  (default: `elevated` — mentor stands down at elevated/critical/shutdown, runs only at
  normal). Wire `budgetOk` to `QuotaTracker.canRunJob('low')` (mentor is low-priority) AND
  the existing run-count backstop (`maxRoundsPerDay` stays — it's a real bound).
- **Add a token-spend ceiling** (`mentor.dailyTokenCeiling`, default 200_000 tokens) summed
  from `TokenLedger` with `attribution.component='mentor-stage-b'`. Hit the ceiling → defer
  with reason `budget-tokens`.
- **Notify on trip**: when `budgetOk` returns false (quota OR run-count OR token-ceiling),
  push **one** entry to the Attention Queue (`POST /attention`) deduped per-day per-reason,
  AND send a single Telegram alert to the system topic. No per-tick chatter — one alert when
  the cap closes, one when it reopens.

## Design (one place to read)

The runner gets three new service dependencies, all small + injectable for tests:
- `getMenteeIdle(menteeFramework): Promise<boolean>` — async probe + fail-closed.
- `quotaStandDown(menteeFramework): { allow: boolean; reason?: string }` — composes quota
  + run-count + token-ceiling; returns the specific blocker.
- `notifyBudgetTrip(reason, detail)` — fires the attention + Telegram alert (deduped).

The tick changes:
- Order is `canary → quota → idle → spawn → leak → forensics → capture → deliver` (idle
  becomes a real async-resolved boolean, computed in `Runner.startTick` so the tick stays
  pure).
- `deps.budgetOk` is replaced by `deps.budget` returning `{ ok, reason }`; on `!ok` the tick
  calls `deps.notifyBudgetTrip(reason)` exactly once (dedup is in the notifier, not the tick).
- `reason: 'unsafe-window'` is renamed `reason: 'mentee-busy'` to match the actual signal.

## Out of scope

- A Codey **liveness** monitor beyond the per-probe fail-closed (separate concern).
- Threadline-relay-based delivery (intentionally rejected — see [[bug_cross_agent_ack_spawn_loop]]).
- Multi-mentee fan-out (one mentee for now).

## Testing

1. **Unit — idle signal:**
   - mentee at-rest → `getMenteeIdle = true` → tick proceeds past the idle gate.
   - mentee `activelyWorking=true` → `getMenteeIdle = false` → tick defers `mentee-busy`.
   - probe timeout / network error / non-2xx → fail-closed: `getMenteeIdle = false` (NEVER
     true on unknown state); a degradation signal is emitted on persistent failure.
2. **Unit — quota-budget:**
   - quota `normal` + under run-count + under token-ceiling → `budget.ok = true`.
   - quota `elevated` → `budget.ok = false, reason = 'quota-elevated'`.
   - run-count cap → `budget.ok = false, reason = 'runs-exhausted'`.
   - token-ceiling hit → `budget.ok = false, reason = 'tokens-exhausted'`.
   - On trip, `notifyBudgetTrip` is called exactly once per (reason, day) — replays don't
     re-notify.
3. **Integration — delivery contract (Echo-side):**
   - `deliverToMentee` writes a well-formed JSONL line at the documented path; the contract
     schema is published as a typed export the Codey-side pickup imports.
4. **End-to-end — supervised live cycle (the actual test):**
   - All three fixes shipped; manually trigger one tick against the real Codey with Justin
     watching; assert Codey receives the message, replies, and Stage-B captures the reply.
     Capture before/after token-ledger spend, attention-queue state, and any degradation
     events.

## Migration parity

- **Config:** `migrateConfig` removes `mentor.dailySpendCapUsd` (silent if absent) and adds
  `mentor.menteeServerUrl`, `mentor.quotaCeiling`, `mentor.dailyTokenCeiling` with defaults
  (existence-checked, only added when missing).
- **No agent-installed file changes** beyond config defaults — loader-only shadow-install update.

## Co-design with Codey (open)

The Codey-side pickup design (option a vs b vs other), the reply-outbox shape, and any
preferred contract details are explicitly open for Codey's input on a fresh Threadline thread
(per the established short-msg + view-link pattern to avoid the command-too-long bug).
Codey's response folds into a §Mentee-side pickup section before convergence.
