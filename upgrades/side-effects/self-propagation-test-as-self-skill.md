# Side-Effects Review — Self-Propagation, Part 2 v1 (/test-as-self skill)

**Spec:** docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md (approved: true) — Part 2 v1 of two. Part 1 (the structural poll-ownership lease) ships separately (PR #446) under the same approved spec. Pairs with it: Part 1 is the structural fix; Part 2 is the verifier that proves Part 1 actually fired in a live deploy + captures crash signatures deterministically.

## What changed
- `.claude/skills/test-as-self/SKILL.md` (new) — runbook: when to use, the tight deploy recipe (pick throwaway dir → init → optional bot config → lifeline start → server start → verify → teardown), and explicit deferrals for v1 (no auto-mint, no full Playwright round-trip, no one-button command yet — those land in Part 2.1).
- `.claude/skills/test-as-self/scripts/verify.mjs` (new) — deterministic post-deploy verifier (~190 lines, no deps): reads the Part 1 lease file (present / fresh / well-formed / tokenHashOnly security check), greps `logs/server.log` for the Part 1 "send-only mode (lifeline owns polling)" demote line, tails server+lifeline logs for the actual crash signatures (FATAL ERROR / heap out of memory / CheckIneffectiveMarkCompact / Abort trap / SIGABRT / libc++abi / Segmentation fault). Single-JSON-report on stdout; exit 0 = all PASS; 1 = fail / crash. Importable for unit testing.
- `src/commands/init.ts` — new `installTestAsSelfSkill(skillsDir)` mirroring `installBuildSkill`: prefers bundled `.claude/skills/test-as-self/*`, falls back to a pointer SKILL.md if the bundle is missing. Wired into `installBuiltinSkills` between `installBuildSkill` and `installAutonomousSkill`. Idempotent (only installs missing files; preserves operator customizations).
- `tests/unit/test-as-self-verify.test.ts` (20) — both sides of every check boundary: lease present/missing/unparseable/wrong-shape, fresh/stale, tokenHash-only (security: rejects raw-token in file; rejects non-64-hex), server demote present/missing/no-log, crash signatures detected per pattern, none on clean logs, line preserved for forensics. Aggregate report: all-pass; any fail; crash-with-other-passes.

## Signal vs authority
The verifier is **diagnostic**, not authoritative — it never modifies the test agent, never restarts processes, never blocks anything. It just reads files and emits a report. Authority to act on the report (e.g. "Part 1 didn't fire, investigate") sits with the operator/agent, where it should.

## Security
- The verifier asserts the lease file contains a 64-hex `tokenHash` AND grep-checks for a raw-bot-token shape (`/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/`). If either fails, `lease.tokenHashOnly` is FAIL with detail "CRITICAL: file appears to contain a raw bot-token shape". This catches a regression where someone accidentally writes the raw token to the lease file.
- The verifier never reads, requires, or echoes a bot token itself.

## Idempotency / migration parity
- New skill → no migration needed per CLAUDE.md (`installBuiltinSkills` is called from `refreshHooksAndSettings` on every update; only writes missing files; preserves customizations). Existing agents receive the skill on next update automatically.
- Bundled SKILL.md + scripts/verify.mjs ship with the npm package via `.claude/skills/test-as-self/`. The fallback path in `installTestAsSelfSkill` covers the (rare) case where the bundle is missing — installs a minimal pointer SKILL.md so the skill exists at the canonical slug.

## Over/under
- OVER: the runbook is operator-followed (not one-button), so it depends on the operator pasting the right paths/tokens. Acceptable for v1 — the operator-friction trade is offset by deterministic verification.
- UNDER: v1 does NOT auto-test a full Telegram round-trip (lifeline polls; verifier confirms the lease; but no probe message is sent and asserted). The Part 1 lease is verified structurally + at the live-log level — that's the high-leverage half. Round-trip + auto-mint + OOM-reproduction-script ship in Part 2.1.

## Interactions
- Pairs with Part 1: the verifier's `server.demoteLogged` check fires the "lifeline owns polling" pattern Part 1 logs. Without Part 1 deployed, that check FAILS — which is correctly diagnostic (says "Part 1 may not be wired"), not a false positive.
- No interaction with the autonomous skill, /build skill, or any other built-in.

## Rollback
Delete the skill dir (`.claude/skills/test-as-self/`), revert the init.ts hook + the new function (3 chunks), revert the test file. Existing agents that already installed the skill keep their copy (the skill is non-destructive — operator can simply `rm -rf .claude/skills/test-as-self/` per their deploy).

## Tests / verification
- Tier 1 unit: 20 tests, both sides of every check boundary; verified imports the REAL verify.mjs (no copy).
- Runtime smoke (manual, performed during this build): wrote a fake lease + demote line + clean logs into a temp dir; `node verify.mjs --dir TMP` returned exit 0 with all checks PASS.
- Tier 3 live: test-as-self before merge — run the runbook end-to-end on a real throwaway agent home, exercise the verifier against the actual live deploy with Part 1 wired, confirm all checks PASS.

## NOT in this PR (tracked, Part 2.1)
- One-button `instar test-as-self` CLI command.
- Auto-mint bot via Secret Drop integration.
- Full Telegram round-trip via the Playwright profile (send probe, assert reply).
- OOM-reproduction script with controlled inputs.
