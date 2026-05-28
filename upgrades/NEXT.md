# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Self-Propagation, Part 2 v1 — the **`/test-as-self` skill**: a deterministic post-deploy verifier for a throwaway agent home. Reads the Part 1 poll-ownership lease (present / fresh / well-formed / tokenHash-only security check), greps the server log for the Part 1 demote line (proves Part 1 actually fired in the live deploy — not just shipped), and tails the server + lifeline logs for the actual crash signatures (heap-OOM / `CheckIneffectiveMarkCompact` / Abort trap / libc++abi / SIGABRT — the signatures the 2026-05-27 mmtest diagnosis had wrong). Emits a single JSON report; exit 0 = all PASS; 1 = fail or crash detected.

Includes a runbook (`SKILL.md`) for the tight deploy recipe and an explicit list of what v1 does NOT do (auto-mint bot, full Playwright Telegram round-trip, one-button command — those ship in Part 2.1 under the same approved spec).

Pairs with Part 1 (the structural poll-ownership lease, shipping in #446).

## What to Tell Your User

- A new `/test-as-self` skill that runs a deterministic check on a throwaway test deploy — verifies Part 1's structural fix actually fired in practice, and captures any crash signature for you instead of you guessing from log forensics.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `/test-as-self` runbook + verifier | Follow the recipe in `.claude/skills/test-as-self/SKILL.md`; run `node .claude/skills/test-as-self/scripts/verify.mjs --dir <test-agent-home>` |

## Evidence

- Bundled skill: `.claude/skills/test-as-self/SKILL.md` + `scripts/verify.mjs`.
- Installer: `src/commands/init.ts` (`installTestAsSelfSkill`, mirrors `installBuildSkill`; non-destructive, idempotent).
- Tests: `tests/unit/test-as-self-verify.test.ts` (20 — both sides of every check boundary; security check rejects raw-token in file).
- Spec: `docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md` (approved). Side-effects: `upgrades/side-effects/self-propagation-test-as-self-skill.md`.
