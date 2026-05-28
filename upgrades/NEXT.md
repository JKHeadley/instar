# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**`instar test-as-self` — one-button throwaway-deploy harness.** Automates what the
test-as-self skill documented as manual steps: deploy the current dist into a
throwaway agent home, start it, optionally run a real Telegram round-trip (Bot HTTP
API), run the deterministic crash/lease verifier, and tear down — a single JSON
report, exit 0 = all PASS. Structural guards make it impossible to point at your
real agent home or a protected agent (Bob), and it refuses a raw bot token on the
command line (Secret Drop only).

## What to Tell Your User

- There's now a one-command way for me to safely test a fresh deploy of myself in
  an isolated sandbox — `instar test-as-self` — before shipping a change that
  touches the startup/deploy path, so I get clean evidence instead of guessing from
  logs. It can't touch your real agent or Bob, and it never takes a bot token on the
  command line.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `instar test-as-self` | `instar test-as-self --no-roundtrip` (deploy+verify) or `--bot-token <secret-drop-id>` (+ Telegram round-trip); `--keep` leaves it running. |
| Structural deploy guards | Automatic — refuses canonical-home / Bob targets (exit 11) and raw tokens on argv (exit 12). |

## Evidence

**New command + pure guards, fully wired (not dead code) + Agent-Awareness entry.**
Unit `tests/unit/test-as-self-validation.test.ts` (12) covers every guard decision
boundary; integration `tests/integration/test-as-self-guards.test.ts` (3) verifies
the orchestrator's no-I/O early-exit codes (11 bad target, 12 raw token). `tsc
--noEmit` + destructive-lint + url-log-lint clean. The round-trip uses the Telegram
Bot HTTP API (not Playwright — more reliable). Deferred follow-up (tracked): SKILL.md
demote + migrator (the v1 runbook still works). Side-effects review:
`upgrades/side-effects/test-as-self-orchestrator.md`. Spec: Track F of
`docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`.
