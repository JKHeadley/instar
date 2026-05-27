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

Replace `isMenteeBusy` with a **mentee-specific** idle check. Convergence (adversarial F1/F2,
integration minor) revealed two blockers in the original draft:

- `/sessions` is **Bearer-token-gated** (`middleware.ts:57`); a cross-agent probe without
  auth always returns 401 → fail-closed → permanent silent deferral.
- `SessionManager` session records have **no `activelyWorking` field** (grep returns 0 hits) —
  only `status:'running'`. A 200 with empty array is ambiguous (truly idle vs. mentee server
  crashed-and-restarted-clean), and a single-session-at-prompt-for-hours looks identical to
  active work.

**Required Codey-side addition:** a dedicated **unauthenticated** `GET /idle` endpoint Codey
ships on his server. Returns a structured response Echo can trust:
```json
{
  "schemaVersion": 1,
  "idle": true,
  "bootId": "uuid-set-at-process-start",
  "uptimeSec": 12345,
  "activeSessions": 0,
  "ts": "ISO-8601"
}
```
- `idle` = true iff Codey reports no sessions doing work right now.
- `bootId` + `uptimeSec` let Echo detect mentee restart-since-last-probe (treat as busy for
  one min-interval after a fresh boot, so we don't pile on a recovering Codey).
- Unauthenticated because (i) it leaks no sensitive state, (ii) avoids the
  cross-agent shared-Bearer-secret trust boundary.

**Echo-side wiring:**
- Resolve from `mentor.menteeServerUrl` (default `http://localhost:4044` for `codex-cli`).
- `GET {menteeServerUrl}/idle` with a 750ms timeout.
- **Fail-closed on every ambiguous outcome:** non-2xx, network/timeout, JSON-parse failure,
  unrecognized schemaVersion, missing required fields, OR `idle !== true` → treat as
  **busy** (never silently flip to idle).
- **Liveness inferred from heartbeat, not 200-empty-array** — if `idle:true` but
  `uptimeSec < minIntervalMs/1000`, defer one more cycle.
- Persistent probe failure (≥3 consecutive) emits a `DegradationReporter` event with
  feature `'mentor.menteeProbe'` — surfaces in `/degradation`, not silent.
- The check is async; the runner pre-resolves it before assembling tick deps (the tick stays
  pure).
- **Defer reasons are split** (per adversarial minor): `mentee-busy` (probe says busy /
  failed / liveness-warmup) and `min-interval-not-elapsed` are distinct strings so debugging
  doesn't collapse them.

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

#### Hardening (convergence round 1)

**Cross-agent filesystem safety (adversarial F3, integration F1).** The current
`deliverToMentee` uses raw `fs.mkdirSync` + `fs.appendFileSync` — no symlink check, no path
canonicalization. Echo writes into *another agent's* state dir, so the attack/misconfig
surface is real. New Echo-side requirements:

1. **Symlink reject**: `lstat` the target path before each append; if it's a symlink, refuse
   the write and emit `DegradationReporter` event `mentor.delivery.symlink-rejected`.
2. **menteeStateDir allowlist**: validate `mentor.menteeStateDir` at startup — refuse if it
   resolves to Echo's own `stateDir`, contains `..`, or doesn't look like an instar agent
   home (no `.instar/config.json` at the root). Refuse-to-start with a loud error rather
   than silently writing into the wrong place.
3. **Append-only contract documented**: raw `appendFileSync` is correct for JSONL (atomic at
   line granularity on POSIX for `<PIPE_BUF`); document why `SafeFsExecutor` is NOT used for
   this path (its destructive-op guards don't apply to append) so a future reviewer doesn't
   "fix" it incorrectly.

**Delivery failure must surface (adversarial F4).** Current shape silently swallows EACCES /
ENOSPC / EROFS → tick reports `delivered:true` even when nothing was written. Required:
- `deliverToMentee` returns `{ ok: boolean; reason?: string }` (was void).
- Tick's `delivered` boolean reflects the callback's `ok`.
- On `!ok`, runner pushes ONE Attention entry deduped per (reason, day) using the same
  primitive as the budget-trip notifier (Fix 3). Otherwise a permanently-broken Codey disk
  burns the daily run budget silently.

**Anti-loop made structural (lessons 1, adversarial F5).** The eight contract constraints
are correct but currently behavioral promises. Make them compile-/test-time invariants:

1. **Stage-B reply ingestion is finding-emission-only.** Define explicitly: when Stage-B
   reads `reply.jsonl`, the only output path is `capture({findings})` — there is NO code
   path from reply ingestion to `spawnStageA` or `deliverToMentee`. Implementation: Stage-B
   reply parser returns `ForensicFinding[]`; the tick passes them only to `capture()`.
2. **Unit test (the structural assertion):** "given a reply row landed, the next tick still
   defers on `mentee-busy` / `min-interval-not-elapsed` and does NOT call `deliverToMentee`
   or `spawnStageA`" — proves no implicit recurrence path exists.
3. **Import-surface lint** for the mentor-delivery module: arch-test asserts the module's
   imports are a subset of `{ fs, path, mentor-contract-types }` — no `threadline_send`, no
   `spawnSession`, no `fetch`/`http`. Build fails on regression. Turns rule 1 of the
   contract from promise into compile-time invariant.

**Schema-version negotiation (adversarial F7, integration F6, lessons F6).** SchemaVersion=1
ships today; bumps need a rule, not a Threadline round-trip every time.
- Echo exports `MENTOR_CONTRACT_VERSION` (a constant + a typed `MentorPrompt` /
  `MentorReply` schema) Codey imports/vendors with a pinned version.
- Echo serves the schema at `GET /mentor/contract` (unauthenticated read-only — schema is
  not sensitive) so Codey can fetch + assert at startup if vendoring isn't workable.
- **Within v1**: additions are additive-only (new optional fields allowed; required
  fields/renames forbidden).
- **Breaking change → v2**: bumps land on the **reader-first** (Codey, who reads prompts AND
  writes replies — gets v2 understanding first), then on Echo (writer). Older readers seeing
  newer lines → dead-letter row with a `schema-version-too-new` reason (not crash, not
  silent).
- CI gate: a bump to `MENTOR_CONTRACT_VERSION` requires a corresponding entry in
  `docs/specs/MENTOR-CONTRACT-CHANGELOG.md` — script lints this on PR.

### Fix 3 — Quota-aware budget + notification (replaces the dead dollar cap)

- **Remove** `dailySpendCapUsd` from config defaults; replace with `mentor.quotaCeiling`
  (default: `elevated` — mentor stands down at elevated/critical/shutdown, runs only at
  normal). Wire `budgetOk` to `QuotaTracker.canRunJob('low')` (mentor is low-priority) AND
  the existing run-count backstop (`maxRoundsPerDay` stays — it's a real bound).
- **Quota null/stale → fail-closed (integration F2).** `QuotaTracker.getState()` returns
  null when the quota state file is missing or stale (>30 min), and `shouldSpawnSession`
  fails-OPEN by default. For the mentor, override to **fail-closed**: null/stale ⇒
  `budget.ok = false, reason = 'quota-unknown'`. Consistent with Fix 1's idle posture; we
  don't burn quota blindly when we can't read it.
- **Add a token-spend ceiling** (`mentor.dailyTokenCeiling`, default 200_000 tokens) summed
  from `TokenLedger`. **Integration F3 correction:** `TokenLedger.attribution_key` shape is
  `<component>::<promptFingerprint>`, not bare `mentor-stage-b` — sum via prefix-match
  (`key LIKE 'mentor-stage-b::%'`) over `byAttributionKey({sinceMs})`, OR add a thin
  `byComponent('mentor-stage-b', {sinceMs})` helper. The spec ships the helper for clarity.
  Hit the ceiling → defer with reason `budget-tokens`.
- **Notify on trip — state-machine, not day-bucket (adversarial F6, lessons F5).** Per-
  episode dedup is correct; per-day is wrong (a trip→recover→re-trip same day MUST re-alert
  on the re-trip — that's exactly when Justin needs to know). State machine:
  - Track `currentTripState ∈ {ok, tripped}` per `reason` (one of `quota-elevated`,
    `quota-unknown`, `runs-exhausted`, `budget-tokens`, `delivery-failed`).
  - **Alert on transition `ok → tripped`** (one Attention entry + one Telegram alert).
  - **Alert on transition `tripped → ok`** (one "recovered" message — symmetry, so the user
    knows we're back).
  - Within state, suppress (no chatter on every tick).
  - **Persistence: file-backed** at `state/mentor-budget-notifications.json` via
    `SafeFsExecutor.atomicWriteJsonSync` so a mid-day server restart does NOT re-alert
    (integration F4). In-memory alone re-spams.
  - **Optional "still tripped after N hours" reminder** (default off, configurable via
    `mentor.budgetReminderHours`) for long-running trips (e.g. quota stays elevated for 6h).

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
   - `/idle` returns `{idle:true, uptimeSec: large}` → `getMenteeIdle = true` → tick
     proceeds past the idle gate.
   - `/idle` returns `{idle:false, ...}` → defers `mentee-busy`.
   - `/idle` returns 200 with `idle:true` but `uptimeSec < minInterval` → defers
     `mentee-busy` (liveness-warmup).
   - **Fail-closed coverage:** non-2xx, network/timeout, JSON-parse failure, unknown
     `schemaVersion`, missing required fields, AND a 200 with `idle:true` but missing
     `bootId`/`uptimeSec` (schema drift) → ALL produce `getMenteeIdle = false`. No path can
     silently flip to idle.
   - Persistent failure (≥3 consecutive) emits a `DegradationReporter` event.
2. **Unit — quota-budget:**
   - quota `normal` + under run-count + under token-ceiling → `budget.ok = true`.
   - quota `elevated` → `budget.ok = false, reason = 'quota-elevated'`.
   - **quota state `null`/stale** → `budget.ok = false, reason = 'quota-unknown'`
     (fail-closed, not the QuotaTracker default fail-open).
   - run-count cap → `budget.ok = false, reason = 'runs-exhausted'`.
   - token-ceiling hit (via prefix-match `mentor-stage-b::%`) → `budget.ok = false,
     reason = 'tokens-exhausted'`.
   - **State-machine notify:** `ok → tripped` fires one alert per reason; further `tripped`
     ticks are suppressed; `tripped → ok` fires one recovered alert; `ok → tripped → ok →
     tripped` same day fires THREE alerts (down, up, down) — proving day-bucket dedup is
     replaced by trip-episode dedup. Persistence across simulated server restart.
3. **Integration — delivery contract (Echo-side):**
   - `deliverToMentee` writes a well-formed schemaVersion=1 JSONL line at
     `{menteeStateDir}/mentor-outbox/codex-cli.jsonl`; the contract schema is exported as
     `MentorPrompt`/`MentorReply` types + `MENTOR_CONTRACT_VERSION` constant; `GET
     /mentor/contract` serves the schema.
   - **Symlink at target path** → write refused, degradation event emitted.
   - **`menteeStateDir` resolving to Echo's own stateDir** → server refuses to start.
   - **`deliverToMentee` returns `{ok:false, reason}`** when the write fails (EACCES /
     ENOSPC simulated via fs mock) → tick reports `delivered:false` + one Attention entry
     (deduped by the same notifier primitive as the budget-trip).
4. **Integration — bidirectional contract (the #425 gap-closer):**
   - A test-fixture poller (simulating Codey's side) reads `{menteeStateDir}/mentor-
     outbox/codex-cli.jsonl` using the **exported typed contract**, writes a `delivery.jsonl`
     row then a `reply.jsonl` row, and Echo Stage-B parses both. Asserts: the round-trip
     produces a `ForensicFinding`, and the next tick still defers (does NOT call
     `deliverToMentee` or `spawnStageA` — proves the anti-loop is structural). This is the
     test #425's "validate the artifact but never drive the full path end-to-end" gap.
5. **Wiring-integrity — production deps are real:**
   - When the runner is constructed from production wiring (not the test factory),
     `getMenteeIdle` / `quotaStandDown` / `notifyBudgetTrip` are non-null, non-no-op, and
     delegate to the real probe / `QuotaTracker` / Attention+Telegram path. Catches the
     "shipped as null/no-op" failure mode.
6. **Import-surface lint:**
   - Static check: the mentor-delivery module's import set is a subset of `{fs, path,
     mentor-contract-types}`. Build fails if `threadline_send`, `spawnSession`, or
     `fetch`/`http` are introduced. Anti-loop rule 1 is now compile-time, not promise.
7. **End-to-end — supervised live cycle (the actual test):**
   - All three fixes shipped + Codey's pickup shipped; manually trigger one tick against
     the real Codey with Justin watching; assert (a) `/idle` probe succeeds and returns
     `idle:true`, (b) Echo writes the schemaVersion=1 prompt line, (c) Codey's poller
     ingests + writes the delivery row (immediately) then the reply row (after the
     assistant response), (d) Stage-B parses both + emits findings, (e) the next tick
     defers (no auto-recurrence). Capture before/after token-ledger spend, attention-queue
     state, and any degradation events.

## Migration parity

- **Config (additive):** `ConfigDefaults.getMigrationDefaults()` adds `mentor.menteeServerUrl`,
  `mentor.menteeStateDir`, `mentor.quotaCeiling`, `mentor.dailyTokenCeiling`,
  `mentor.budgetReminderHours` with defaults — `applyDefaults` is existence-checked, only
  fills missing fields (integration F5 confirms the right primitive).
- **Config (removal) — NOT silent (lessons 4, adversarial F8).** `applyDefaults` is
  additive-only and can't remove fields. Add an explicit `migrateConfig` step (modeled on
  `migrateLegacyMaxSessions`, `PostUpdateMigrator.ts:~3961`) that:
  1. If `mentor.dailySpendCapUsd` is present AND equals the historical default `0.5`, delete
     it silently (no warning — they never changed it).
  2. If it's present AND ≠ `0.5`, **emit one Attention-queue entry** explaining the field
     was decorative ("your `mentor.dailySpendCapUsd: <value>` was never enforced because
     Echo runs on a Claude subscription — there's no per-token dollar charge to cap. Your
     new effective ceiling is `mentor.dailyTokenCeiling: 200000` tokens/day. Adjust if
     needed."), then delete the field. Idempotent (re-run = no-op once the field is gone).
  3. Repeating the original "silent dead config" bug at migration time is precisely the
     learning-experience failure mode — surface it loudly.
- **No agent-installed file changes** beyond config defaults — loader-only shadow-install
  update for Echo's side; Codey's side is a separate PR in his repo (which adds his
  `mentor-inbox-poll` job + the `/idle` endpoint).

## Co-design with Codey

**Round 1 (closed — Threadline thread 5cc61bd7, 2026-05-27).** All five co-design questions
resolved by Codey (senior-grade input): option (a) scheduled poll job; stateDir-relative
paths; schemaVersion=1 with stable `id`/`correlationId`; full reply schema with `status`
enum + optional `error`; eight anti-loop constraints; plus the separate-delivery-vs-reply
audit-row insight Stage-B uses to distinguish never-picked-up / picked-up-no-reply-yet /
completed. Folded above (§Fix 2).

**Round 2 (open — convergence added two Codey-side requirements after round-1 review):**

1. **Unauthenticated `GET /idle` endpoint on Codey's server.** Convergence found `/sessions`
   is Bearer-authed (can't be cross-agent probed) and has no `activelyWorking` field — so
   the spec's idle signal needs a dedicated endpoint Codey ships. Schema in §Fix 1.
2. **Vendoring of `MENTOR_CONTRACT_VERSION` + typed schema** (Echo exports + serves at
   `GET /mentor/contract`). Codey's poll job imports/asserts the version at startup.

Both are small but they're requirements on Codey's side that convergence imposed *after* his
round-1 answers. They go to Codey for confirmation before this spec converges and ships.
