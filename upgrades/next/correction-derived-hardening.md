# Correction-Derived Hardening — B21 user-task-substitution gate rule + owned-identities self-unblock probe

## What Changed

- The outbound tone gate gains rule `B21_USER_TASK_SUBSTITUTION`: a message
  handing the USER a multi-step procedure (portal click-paths, UI steps,
  command sequences) for work the agent could do itself given at most a
  credential or an approval is caught before it sends. Explicit carve-outs keep
  legitimate messages flowing: user-requested walkthroughs, structurally
  human-reserved actions (dashboard-PIN, physical, payment/legal, CAPTCHA,
  decisions), single one-tap links/codes, genuinely non-delegable personal
  credentials, and a capability-uncertainty default-PASS.
- The Self-Unblock checklist gains a tenth probe source, `owned-identities`:
  a per-agent registry (`.instar/owned-identities.json`) of identities the
  agent itself provisioned (test users, workspace owners, service accounts).
  Entries advertise their scopes ONLY while their credential pointer resolves
  (agent-home-jailed file stat / vault key-name presence — fail-closed), with
  hard bounds (256 KB, 500 entries, 128-char strings) and no secret value ever
  read or surfaced.
- CLAUDE.md template + migration: agents learn Rung 0 includes identities they
  created, the registration trigger, the canonical scope-tag form, and the
  prune-stale-entries rule (append-only content-sniffed migration).

## Evidence

- Spec: docs/specs/correction-derived-hardening.md (converged iter 2,
  codex-cli:gpt-5.5 external both rounds; report in docs/specs/reports/).
- Tests: tests/unit/messaging-tone-gate-b21.test.ts (7),
  tests/unit/SelfUnblockProbeProviders.test.ts (+10 incl. founding-scenario
  reproduction, jail, clamp, stale-exhausts, wiring ratchet),
  tests/unit/SelfUnblockChecklist.test.ts (order updated),
  tests/unit/PostUpdateMigrator-ownedIdentities.test.ts (4). All green with
  the existing ratchets (rule-id contract, judge-by-meaning keyset).

## What to Tell Your User

Two of your July 18 corrections are now built into the shared machinery. I can
no longer send you step-by-step click instructions for something I could do
myself — the message gate catches that shape before it reaches you; the most
I'll ask for is a credential or a yes/no. And before I ever claim something
"needs you," my blocked-task checker now also consults a registry of accounts
and identities I myself created — so I can't again ask you about
infrastructure I built.

## Summary of New Capabilities

- Outbound gate rule B21: no more click-lists handed to users for agent-doable
  work.
- Self-unblock now structurally consults agent-provisioned identities before
  any "operator-only" escalation; register identities you create in
  `.instar/owned-identities.json`.
