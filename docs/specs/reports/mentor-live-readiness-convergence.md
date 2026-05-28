# Convergence Report — Mentor live-readiness

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md`
**Iterations:** 2 rounds, 3 reviewers each round (lessons-aware, integration, adversarial)
**Co-designer:** instar-codey (Threadline thread 5cc61bd7, §Fix 2 mentee-side pickup)
**Outcome:** CONVERGED. Fix direction (real /idle endpoint + Codey-designed outbox pickup +
quota-aware budget+notify) endorsed by all reviewers in both rounds.

## Round 1 verdicts

| Reviewer | Verdict | Headline |
|----------|---------|----------|
| Lessons-aware | APPROVE-WITH-CHANGES (6) | Anti-loop behavioral not structural; #425 test-gap not closed; budget dedup wrong shape |
| Integration | APPROVE-WITH-CHANGES (6) | QuotaTracker null fail-open; TokenLedger attribution shape; SafeFs append guidance; migration removal step |
| Adversarial | APPROVE-WITH-CHANGES (8) | `/sessions` Bearer-authed + no `activelyWorking` field → original probe unimplementable; cross-agent fs symlink/TOCTOU; delivery-failure silent; schema negotiation; dailySpendCapUsd silent removal |

## Round 2 verdicts

| Reviewer | Verdict | Notes |
|----------|---------|-------|
| Lessons-aware | CONVERGED | All 6 round-1 findings closed; no new lessons violations |
| Integration | STILL-CHANGES → CONVERGED after 3 small additions | Echo-independence on /idle absence; budget-notifications JSON shape + concurrency; `GET /mentor/contract` capability/AAS parity |
| Adversarial | STILL-CHANGES → CONVERGED after 2 small additions | State-machine concurrency (CAS + corrupt-file recovery); parent-symlink realpath defense |

## Findings closed (round 1 + round 2)

**Structural / anti-loop:**
- Stage-B reply ingestion = `capture()`-only; explicit "no path to spawn/deliver" + unit test pinning it (lines 244-254, test #4 + 7).
- Import-surface lint on mentor-delivery module (test #6) — anti-loop is now compile-time.
- `GET /idle` unauthenticated + structured (schemaVersion/bootId/uptimeSec/activeSessions);
  fail-closed on every ambiguous outcome; liveness inferred from heartbeat.
- Cross-agent fs writes: lstat-reject symlinks + realpathSync parent check (TOCTOU/
  parent-symlink defense); menteeStateDir allowlist refuses misconfig (refuse-to-start).
- `deliverToMentee` returns `{ok,reason}`; on failure tick reports `delivered:false` +
  dedup'd Attention entry.

**Budget:**
- Trip-EPISODE state machine (not day-bucket); alerts on `ok→tripped` AND `tripped→ok`.
- File-backed persistence at `state/mentor-budget-notifications.json` via
  `SafeFsExecutor.atomicWriteJsonSync` — survives server restart.
- Explicit JSON shape + CAS single-writer + corrupt-file recovery (degradation event).
- QuotaTracker null/stale → fail-closed (`reason: quota-unknown`), overriding the default
  fail-open.
- TokenLedger sum via prefix-match `mentor-stage-b::%` (attribution_key shape correction)
  via thin `byComponent` helper.

**Schema versioning:**
- `MENTOR_CONTRACT_VERSION` export + `GET /mentor/contract` (unauthenticated).
- Reader-first rule for breaking bumps; CI changelog gate.
- Both sides dead-letter unknown schemaVersion (not crash, not silent).

**Migration:**
- `dailySpendCapUsd` removal is NOT silent if user set a non-default value — emit one
  Attention entry explaining it was decorative (don't repeat the silent-dead-config bug).
- Additive new fields via `ConfigDefaults.getMigrationDefaults()` + `applyDefaults`.
- Explicit removal step modeled on `migrateLegacyMaxSessions`.

**Coordination:**
- Echo's side ships independently of Codey's PR; absent `/idle` → continuous `mentee-busy`
  defers + degradation event (NOT refuse-to-start). Graduated-rollout pattern.
- `GET /mentor/contract` route gets CapabilityIndex prefix classification + CLAUDE.md
  template entry (Agent Awareness Standard).

**Testing — the #425 gap is closed:**
- Bidirectional integration test: fixture poller writes delivery + reply, Echo Stage-B
  parses; asserts next tick still defers (no auto-recurrence).
- Wiring-integrity test: production deps non-null, non-no-op.
- Import-surface lint.
- Fail-closed coverage on every ambiguous probe outcome.
- E2E supervised live cycle is the final test (gated on both sides shipped).

## Standards conformance

- Testing Integrity: 7 tests across 3 tiers + lint + wiring + the gap-closer. ✓
- Structure > Willpower: anti-loop made compile-time (lint + ingestion-path-by-construction);
  cross-agent writes guarded structurally (refuse-to-start + symlink reject). ✓
- Signal vs authority: idle/budget gates own blocking authority; tick stays pure. ✓
- Near-silent: state-machine dedup + recovery alert + optional long-trip reminder. ✓
- Migration parity: additive + explicit removal step + non-silent on non-default. ✓
- Bug-fix evidence bar: E2E live test required before declaring "fixed." ✓
- Co-design discipline: §Fix 2 designed by Codey on Threadline; round-2 additions explicitly
  flagged as new asks to Codey before final approval. ✓

## Co-design status

- Round 1 (closed): Codey resolved all 5 questions on Threadline thread 5cc61bd7
  (poll-job + cursor + lock + dead-letter, schemaVersion=1 with id/correlationId, full reply
  schema, 8 anti-loop constraints, two-row audit pattern).
- Round 2 (open): convergence added two Codey-side requirements after round-1:
  unauthenticated `GET /idle` endpoint, and vendoring `MENTOR_CONTRACT_VERSION`. Both go to
  Codey for confirmation before this spec ships.

---

## Convergence on Telegram-substrate design (2026-05-27, AFTER Justin substrate correction)

The prior two rounds (above) hardened a file-based mentor-outbox design that Justin
(topic 13435) caught as solving the wrong problem (substrate vs discipline). Spec
re-architected onto Telegram-substrate + an agent-to-agent comms primitive. ONE NEW
convergence round on the Telegram substrate; all reviewers APPROVE-WITH-CHANGES with
substantial implementation-surface findings (the substrate change exposed real
TelegramAdapter limits).

### Telegram-substrate round verdicts

| Reviewer | Verdict | BLOCKING findings |
|----------|---------|---|
| Lessons-aware | APPROVE-WITH-CHANGES | `TelegramAdapter.onMessage` is single-handler setter, not chain — spec's "agent-handler runs BEFORE user routing" unimplementable as-stated |
| Integration | APPROVE-WITH-CHANGES (3 BLOCKING) | (F1) Multi-instance TelegramAdapter state-file collision; (F2) handler-chain primitive; (F3) Stage-A is unattributed in TokenLedger — Stage-B-only honest scope |
| Adversarial | APPROVE-WITH-CHANGES (5 BLOCKING) | (F1) User-typed marker spoofing; (F3) `corr` collapse on absence; (F4) lint depth unspecified; (F6) per-source role acceptance; (F8) tick-while-in-flight rebuilds ping-pong |

### Closures (all BLOCKING findings folded)

- **Handler chain**: wrap at registration site in `src/commands/server.ts:~3038` — agent-
  handler first, fall through to user-routing on `handled:false`. Wiring-integrity test.
- **Multi-instance state isolation**: new constructor `subDir?: string` param namespaces
  every state file under `{stateDir}/agent-telegram/<botName>/`; `suppressLifelineAutoCreate?`
  guards `ensureLifelineTopic()`. Primary bot unchanged.
- **Stage-A honest scope**: renamed `dailyTokenCeiling` → `stageBTokenCeiling`; documents
  the unknown::pre-attribution gap; follow-up tracked for Stage-A attribution-resolver.
- **User-spoof defense**: spec extends Message type to expose `from.is_bot` + `sender_chat`;
  allowlist key is `sender_chat.id` OR (`from.id` AND `from.is_bot===true`); marker-bearing
  message from a human user → DROP `agent-marker-spoofed-by-user`.
- **`corr` required in parser**: cycle-detection key cannot collapse; prompts self-correlate
  (`corr=id`).
- **Capability-handle for reply-ingestion**: reply-ingestion module receives only
  `{capture}` handle — structurally cannot reach spawnStageA/deliverToMentee/scheduler/
  Threadline. Dependency-cruiser lint as backup. Stronger than transitive-import lint.
- **Per-source role-acceptance**: `{fromAgent → allowed-incoming-roles[]}`, not flat.
  Compromised mentee sending `notify`/`coord` → DROP.
- **Outstanding-prompt tick refusal**: `outstandingPrompts: Map<corr, {sentAt, mentee}>`;
  tick refuses while a prompt is in-flight within `mentor.replyTimeoutMs` (default 20min);
  expiry → `mentor.reply-orphaned` degradation + Attention. Solves both the rebuilt
  ping-pong AND silent-reply-loss observability in one primitive.

### Other tightenings

- Marker `ts=<unix-ms>` + `a2a.skewWindowMs` (default 24h) → replay defense without HMAC.
- Token-leak scrub in `sendAgentMessage` error paths; rotation flow.
- Migration: dedicated methods (`migrateRetireDeadMentorConfig`, `migrateRetireMentorOutbox`)
  via SafeFsExecutor with `_instar_migrations` markers (no existing migration does fs-cleanup
  — pattern-fit correction).
- Secret-Drop's existing one-time-URL + Telegram confirmation suffices for `mentor.botToken`;
  "OOB-confirmed" was not an existing pattern — dropped (correction).
- CapabilityIndex already classifies `/mentor` prefix — `POST /mentor/bot-setup` inherits;
  Echo only needs CLAUDE.md template entry (correction to prior draft).
- Line number citation fix: `TelegramAdapter.onMessage` is line 1592, not 1327 (caught
  by lessons reviewer — applies today's verify-before-claiming lesson).

### Status

CONVERGED on Telegram substrate. All BLOCKING findings folded; spec is approval-ready
pending Justin's nod.
