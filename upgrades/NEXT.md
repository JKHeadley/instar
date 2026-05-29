# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->

## What Changed

Added a **CrossSessionCoordinator** — a light, advisory cross-session coordination
signal. A single agent home can run multiple concurrent Claude Code sessions against
the same `.instar/` state, and they are blind to each other. On 2026-05-28 two
sessions took opposing durable actions — one built a fix while another flipped a
feature flag off and withdrew 19 commitments — with neither aware of the other.

The coordinator is a shared, append-only scratchpad of recent high-impact structural
actions plus voluntary "I'm about to do X" intents. Any structural action surfaces
other recent entries by a different or unknown session as an advisory
`coordinationWarning`. It never blocks and never mutates the target state — it is
purely a heads-up.

- New routes: `POST /coordination/intent` (announce an intent) and
  `GET /coordination/recent` (inspect the ledger, newest first).
- Backstop auto-recording: sensitive `PATCH /config` flips and
  `POST /commitments/:id/withdraw` calls record themselves and attach a
  `coordinationWarning` to their own response when another session was recently active
  — so the signal works even without an explicit announcement.
- Wired into AgentServer (always alive — read routes return 200, not 503) with a
  CapabilityIndex entry under `/coordination`.
- Default-ON housekeeping, near-silent (no Telegram). Audit trail at
  `logs/cross-session-events.jsonl`. Config: `monitoring.crossSessionCoordination`.
- Migration parity: config default ships to existing agents via ConfigDefaults, and a
  CLAUDE.md awareness section is added via `migrateClaudeMd` + `generateClaudeMd`.

## What to Tell Your User

- **Sessions that notice each other**: "If more than one of me is ever working at the
  same time, we can now see each other's big moves before acting — so we don't
  accidentally undo each other's work. It's a gentle heads-up, not a lock: nothing
  gets blocked, I just get nudged to double-check with you first when another me was
  recently active."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Announce a cross-session intent | POST /coordination/intent |
| Inspect recent cross-session actions | GET /coordination/recent |
| Advisory warning on config flips and commitment withdrawals | automatic |

## Evidence

Driven by two real incidents on 2026-05-28 (topic 15579): (1) a stale "still working"
flag, where one session kept narrating progress over another session's already-completed
work; and (2) two sessions taking opposing durable actions — one built the proper fix
while a second flipped a feature flag off and mass-withdrew 19 commitments, neither
aware of the other, so the bug was fixed but the engine was left off and the test bed
was wiped.

Verification: three test tiers green. Unit (16) includes a regression test for an
intent-dedup defect found during implementation review — two distinct intents were
collapsing into one and suppressing the warning; fixed so intents are never deduped.
Integration (8) exercises both incident vectors over live HTTP: a config-flag flip and
a commitment withdrawal each return the advisory warning while the action itself still
succeeds (advisory, never blocking). An e2e lifecycle test (6) boots the real
AgentServer and confirms GET /coordination/recent returns 200 with the signal surfacing
end-to-end. Migration-parity tests (5) confirm existing agents receive the config
default and CLAUDE.md awareness on update.
