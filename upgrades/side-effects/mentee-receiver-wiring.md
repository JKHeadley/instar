# Side-Effects Review — mentee receiver wiring (framework-level)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side. Symmetric
counterpart to `installMentorReceiverHook` (which catches mentor-REPLIES on
Echo's mentor BOT) — `installMentorMessageHook` catches mentor PROMPTS on the
mentee's PRIMARY adapter.

**Change:** Three files in src/ + four test files. One new exported config
type, one new install method on `AgentServer`, one call site in
`AgentServer.start()`, and one new defaults block in `ConfigDefaults.ts`.

**Files:**
- `src/messaging/MenteeReceiverConfig.ts` (new — type + DEFAULT_MENTEE_CONFIG)
- `src/server/AgentServer.ts` (+ ~165 LoC: `installMentorMessageHook` +
  `getMenteeConfigSnapshot` + the call site in `start()` + one import)
- `src/config/ConfigDefaults.ts` (+ 16 LoC: the `mentee` defaults block)
- `tests/unit/MenteeReceiverConfig.test.ts` (new, 7)
- `tests/unit/PostUpdateMigrator-mentee-block.test.ts` (new, 3)
- `tests/integration/mentee-receiver-install.test.ts` (new, 6)
- `tests/e2e/mentee-receiver-lifecycle.test.ts` (new, 4)

## What changed

1. **`installMentorMessageHook`** on `AgentServer` — invoked from
   `start()` after the primary `TelegramAdapter` is set. Checks
   `config.mentee.enabled` AND `localAgentName` AND non-empty `knownMentors`
   AND `replyChatId` AND `replyTopicId`. Any missing piece logs a one-line
   skip and returns — no half-wired state. No telegramAdapter? Returns early
   cleanly. When fully configured, builds a `RecipientConfig` with the
   knownMentors allowlist + per-source acceptRoles
   (`{ <mentorName>: ['mentor'] }`), composes the hook via
   `buildAgentMessageHook`, and installs it on the primary adapter via
   `setAgentMessageHook`.
2. **Mentor role-handler (orchestrator-bound, NOT a handler capability):**
   spawns a mentee session with `msg.body` as prompt and the agent's default
   tool grant (NOT Stage-A's empty allowlist — the mentor is asking for real
   work), bounded-waits up to `sessionTimeoutMs` (default 5 min) mirroring
   the Stage-A poll pattern, kills on timeout, captures the tmux transcript,
   and sends the reply back via `sendAgentMessage` with `role='mentor-reply'`
   and `corr=msg.corr || msg.id`. Reply-out is inside the handler closure
   but uses orchestrator-bound state (the captured adapter, ledger,
   `cfg.replyChatId`/`replyTopicId`) — handlers cannot route around the
   declared `allowedRoles: ['mentor-reply']` because the SendAgentMessage
   dep injection is constructed at install time, not handed to handlers.
3. **`MenteeConfig` type + DEFAULT_MENTEE_CONFIG** at
   `src/messaging/MenteeReceiverConfig.ts` — ships-dormant by construction:
   `enabled: false` AND every required-when-enabled field defaults to an
   empty/zero value so a single accidental toggle to `enabled: true` cannot
   wire anything up (defense-in-depth tested in the unit suite).
4. **`config.mentee` block in `ConfigDefaults.ts`** — picked up automatically
   by the canonical `applyDefaults` pass in `migrateConfig`, so existing
   agents receive the dormant block on the next update with zero per-field
   migration code (regression test
   `tests/unit/PostUpdateMigrator-mentee-block.test.ts` proves this).

## The seven questions

1. **Over-block.** N/A. The installer is additive — it adds a hook on top of
   normal user routing. Inbound messages without an a2a marker fall through
   to the existing `onTopicMessage` path unchanged (spec §Routing matrix:
   "No marker present → Fall through to normal user handling").
2. **Under-block.** Five structural gates between "enabled" and "hook
   installed" — each tested. Anti-spoof is already enforced inside the hook
   composer (`buildAgentMessageHook` ships the `from.is_bot` /
   `sender_chat` check). The per-source `acceptRoles` matrix narrows
   admission to exactly `{ <mentorName>: ['mentor'] }` so an allowlisted but
   compromised mentor cannot inject a different role.
3. **Level-of-abstraction fit.** Mirrors `installMentorReceiverHook` line-
   for-line for the parts that overlap (same hook-composition shape, same
   ledger + processedIds wiring). The mentee handler shares the bounded-wait
   pattern from `spawnStageA`. No new abstraction introduced.
4. **Signal vs authority.** The receiver hook DECIDES (routes or drops) per
   the spec's explicit routing matrix; the handler is capture-only by
   construction (no `sendAgentMessage` handle); reply-out is bound at install
   time with an `allowedRoles: ['mentor-reply']` set. The decision authority
   is the hook + handler; signal-only otherwise (audit ledger writes only).
5. **Interactions.** Reuses the existing `getOrCreateA2aLedger` +
   `getOrCreateA2aProcessedIds` lazy constructors that Echo's mentor side
   already uses — both sides write to the same audit + processed-id stores.
   Both the sender and receiver are now in instar source, so a future
   refactor could fold them through one shared `installAgentMessageHook`
   site; deferred to keep this PR scoped.
6. **External surfaces.** No new HTTP routes, no new config files. The new
   `config.mentee` block is the only surface and ships dormant.
7. **Rollback cost.** Trivial — revert removes the import, the install
   method, the call site in `start()`, the type file, and the
   `ConfigDefaults.ts` block. Existing agents that took the migration
   backfill keep the dormant `mentee: { enabled: false, ... }` keys; they
   become inert noise rather than active wiring.

## Testing

20 new tests, all green (`tsc --noEmit` clean, full file suite green via
`npx vitest run tests/unit/MenteeReceiverConfig.test.ts
tests/unit/PostUpdateMigrator-mentee-block.test.ts
tests/integration/mentee-receiver-install.test.ts
tests/e2e/mentee-receiver-lifecycle.test.ts`):

- **Tier 1 unit (10 total):** `MenteeReceiverConfig` (7) covers each ships-
  dormant invariant + the forward-compat frozen-defaults regression guard;
  `PostUpdateMigrator-mentee-block` (3) covers the migration parity
  invariant (block added on missing config, partial-block sub-keys
  backfilled without overwriting user values, idempotent across runs).
- **Tier 2 integration (6):** every gate-bail path through `start()` with a
  recording mock adapter (full config → install runs; missing
  localAgentName → skip; empty knownMentors → skip; missing replyChat/Topic
  → skip; no adapter → no-op).
- **Tier 3 E2E (4):** dormant production-init-path boot (server alive,
  mentor surface unaffected — no cascade); enabled real-install path with
  the wiring-integrity check that `setAgentMessageHook` was called exactly
  once with a function value (proves the install is not a no-op).

## Migration parity

Single-line addition to `ConfigDefaults.ts`. The existing canonical
`applyDefaults` pass in `migrateConfig` recursively backfills missing keys
in nested blocks, so an agent whose `config.json` predates this PR will get
the dormant `mentee` block added on the next `instar` update with no per-
field migration code. The dedicated regression test
`tests/unit/PostUpdateMigrator-mentee-block.test.ts` covers this end-to-end:
absent block → added; partial block → only missing sub-keys backfilled, user
values preserved; idempotent.
