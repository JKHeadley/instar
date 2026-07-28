# Side-Effects Review — `instar test-as-self` orchestrator (MM-Bootstrap Track F)

**Spec:** MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS §Track F (folds the approved Part 2.1).

**Scope.** `src/commands/testAsSelfValidation.ts` (new, pure guards),
`src/commands/test-as-self.ts` (new, the 7-step orchestrator), `src/cli.ts`
(register `test-as-self`), `src/scaffold/templates.ts` (Agent Awareness entry),
`tests/unit/test-as-self-validation.test.ts`,
`tests/integration/test-as-self-guards.test.ts`.

**What it does.** `instar test-as-self` automates the recipe the test-as-self
SKILL documented as manual steps: deploy the current dist into a throwaway agent
home, start it, optionally run a real Telegram round-trip (Bot HTTP API), run the
deterministic `verify.mjs`, and tear down. Seven gated steps; a single JSON
report; exit 0 = all PASS.

**Variance from approved Part 2.1 (documented):** the round-trip uses the
Telegram Bot HTTP API (sendMessage + poll getUpdates) instead of Playwright —
strictly more reliable, no browser/profile/flake, equally faithful.

**Structural guards (pure, unit-tested, fail-fast).**
- `--target` can never be the canonical (running) agent home or a protected
  agent name (Bob) or an explicitly protected home → exit 11.
- `--bot-token` refuses a raw token (Telegram/GitHub/Slack/OpenAI shapes) on
  argv → exit 12. Tokens flow only through Secret Drop, retrieved in-memory via
  the hardened `secret-drop-retrieve.mjs` (never argv/env/transcript).

**Side-effects review.**
- **Throwaway-only by construction** — the target guards make it structurally
  impossible to deploy over a real/protected home; Bob + the canonical home are
  hard-blocked.
- **Secret hygiene** — the bot token never touches argv/env/logs; retrieved to
  memory via Secret Drop. The raw-token-on-argv guard is the enforcement.
- **No-I/O on guard failure** — pre-flight guards reject BEFORE any dir is
  created or process spawned (verified by the integration test), so a bad
  invocation has zero side-effects.
- **Teardown is signal-safe** — runs in a `finally`; SIGTERMs the spawned
  server + lifeline and calls `server stop`. The throwaway home is left in a
  dated `~/.instar/test-deploys/` dir for inspection rather than auto-deleted
  (deletion stays operator/--keep-driven; no rm in the harness — SafeFsExecutor
  is the only sanctioned deletion path).
- **Reuses the shipped deterministic verifier** (`verify.mjs`) for step 6 — no
  duplication of the lease/crash-signature logic.

**Test coverage (3-tier).**
- Unit (`test-as-self-validation.test.ts`, 12): isRawToken across token shapes;
  validateTarget (empty / canonical / protected-name case-insensitive /
  protected-home / clean-accept); validateBotTokenArg (absent / Secret-Drop-ID /
  raw-token-refused).
- Integration (`test-as-self-guards.test.ts`, 3): runTestAsSelf exits 12 on raw
  token, 11 on protected-name target, 11 on canonical-home target — all
  no-I/O early-exit paths, safe in CI.
- E2E / live: the full deploy+verify run is the real-machine backstop (the live
  two-machine proof is Track E); not run in CI (needs a real deploy + bot).

**Migration parity.** The command + validation are server source (dist) →
existing agents get `instar test-as-self` on auto-update; no agent-installed-file
change. The CLAUDE.md template gains an Agent-Awareness entry so new agents know
about it. **Deferred (tracked, not dropped):** demoting the v1 manual recipe in
`.claude/skills/test-as-self/SKILL.md` to "fallback" + a
`PostUpdateMigrator.migrateTestAsSelfSkill()` to patch the on-disk SKILL for
existing agents — the v1 SKILL still works as-is (runbook), so this is polish,
filed as a follow-up.

**Rollback.** Revert the PR. The command disappears; the v1 SKILL runbook
remains. No data change, no migration to reverse.
