# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Mentee receiver wiring landed in the framework.** The agent-to-agent
Telegram comms primitive shipped the SENDER side end-to-end across
PRs #434/#441/#444/#445/#451/#453/#454/#456 (mentor live-readiness). What was
missing was the symmetric RECEIVER side: any instar-hosted agent acting as a
mentee needed to handwrite the wiring itself (parse the a2a marker, gate on
allowlist + acceptRoles, run the role-handler, send the mentor-reply with
matching `corr`). This PR moves that wiring INTO instar source as a
first-class primitive — `installMentorMessageHook` on the primary
`TelegramAdapter`, driven by a new `config.mentee` block.

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side.

The wiring:
- Reads the new `config.mentee` block (defaults dormant: `enabled: false`).
- When fully configured (`enabled` + `localAgentName` + at least one
  `knownMentors` entry + `replyChatId` + `replyTopicId`), installs an
  agent-message hook on the PRIMARY `TelegramAdapter` that intercepts inbound
  a2a-marker messages BEFORE normal user routing, anti-spoof checks the sender
  bot identity, runs the registered `mentor` role-handler, and sends the
  captured reply back via `sendAgentMessage(role='mentor-reply', corr=…)`.
- Capability-handle anti-loop discipline: the role-handler does NOT receive a
  `sendAgentMessage` handle. Reply-out happens in the orchestrator section of
  the handler so handlers stay capture-only and structurally cannot start a
  ping-pong (spec §anti-loop #1).
- Any partial config logs a one-line skip and bails — no half-wired state.
- No telegramAdapter? No-ops cleanly.

**Migration parity** is automatic via the canonical `applyDefaults` pass in
`PostUpdateMigrator.migrateConfig`: adding the `mentee` block to
`ConfigDefaults.ts` is enough for existing agents to receive it on the next
update. A regression test
(`tests/unit/PostUpdateMigrator-mentee-block.test.ts`) proves the backfill
runs, preserves user-set values, and is idempotent.

## What to Tell Your User

If your agent is going to act as a mentee (receive directed work from another
instar agent's mentor bot via Telegram), I now have a built-in receiver — you
turn it on in config by naming yourself, listing which mentor agents you'll
accept work from, and pointing me at where to send replies. Defaults are off,
so nothing changes unless you ask. For most agents this is invisible internal
infrastructure for cross-agent collaboration.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `config.mentee.enabled` + `localAgentName` + `knownMentors` + `replyChatId` + `replyTopicId` | Set the full block in `.instar/config.json` to opt in as a mentee. The primary TelegramAdapter gets the agent-message hook installed at server start — any a2a marker from an allowlisted mentor is routed to the mentor role-handler, run through a mentee session, and replied to. |
| Automatic config backfill | Existing agents get the dormant `mentee` block added on the next `instar` update via the canonical defaults pass — no per-field migration needed. |

## Evidence

20 new tests, all green: 8 unit tests across `MenteeReceiverConfig` (ships-
dormant invariants, type defaults, forward-compat freeze) and
`PostUpdateMigrator-mentee-block` (backfill behavior, preservation of user
values, idempotency); 6 integration tests in
`mentee-receiver-install.test.ts` covering each gate-bail path (enabled +
full → install runs; enabled + missing localAgentName → skip; empty
knownMentors → skip; missing replyChatId/Topic → skip; no telegramAdapter →
no-op); 6 E2E tests in `mentee-receiver-lifecycle.test.ts` covering dormant
production-init-path boot + enabled real-install with wiring-integrity check
(setAgentMessageHook actually invoked with a function, not a no-op).
`tsc --noEmit` clean. Side-effects review:
`upgrades/side-effects/mentee-receiver-wiring.md`.
