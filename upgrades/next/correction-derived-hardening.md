# Correction-Derived Hardening — B21 user-task-substitution gate rule + owned-identities self-unblock probe

## What Changed

- The outbound tone gate gains rule `B21_USER_TASK_SUBSTITUTION` — the gate's
  FIRST ADVISORY-disposition rule (operator directive: sentinels nudge, the
  agent decides, overrides are recorded). A message handing the USER a
  multi-step procedure (portal click-paths, UI steps, command sequences) for
  work the agent could do itself given at most a credential or an approval is
  returned to the agent as a named nudge (422 tone-gate-advisory, notSent) —
  never hard-blocked; the agent may revise, or resend unchanged with
  `metadata.toneAdvisoryAck` (the override is recorded for the decision-quality
  meter). A new `RULE_DISPOSITIONS` registry makes the advisory/blocking split
  structural; the ack can never override a blocking rule. Explicit carve-outs keep
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

Two of your July 18 corrections are now built into the shared machinery. When
I draft a message handing you step-by-step click work I could do myself, the
gate now hands it BACK to me with the pitfall named — I make the final call,
and if I consciously overrule the nudge, that decision is recorded and
reviewable. This is the nudge-not-block sentinel architecture you asked for,
applied to its first rule. And before I ever claim something
"needs you," my blocked-task checker now also consults a registry of accounts
and identities I myself created — so I can't again ask you about
infrastructure I built.

## Summary of New Capabilities

- Outbound gate rule B21: no more click-lists handed to users for agent-doable
  work.
- Self-unblock now structurally consults agent-provisioned identities before
  any "operator-only" escalation; register identities you create in
  `.instar/owned-identities.json`.
