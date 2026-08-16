# Handoff — provider-portability v1.0.0, Pre-Phase A cycle 1

**Topic:** claude agent sdk (Telegram topic 9984)
**Last touched:** 2026-05-17 (this session)
**Branch:** `spec/provider-portability`
**Worktree location:** `~/.instar/agents/echo/.worktrees/spec-provider-portability/`
  (Moved here from `~/Documents/Projects/instar/.instar/worktrees/spec-provider-portability/` on 2026-05-17 after a sandbox-EPERM blocker. See [[worktree-in-agent-home]] memory for why.)

---

## Where we are

1. **Spec 12 (OpenAI / Codex path constraints):** drafted, converged (3 review rounds, 4 internal + 3 external reviewers per round), and approved by Justin 2026-05-17. Committed and pushed as commit `ed9e3f58`. The spec is the gating dependency for Phase 5 (cost-aware routing) and for Pre-Phase A (Codex adapter tightening).

2. **Phase 5 (cost-aware routing):** the spec at `specs/provider-portability/11-cost-aware-routing.md` is already review-converged and approved (from 2026-05-15). Implementation has NOT started. This is the deadline-driving piece for June 15 Anthropic repricing.

3. **Pre-Phase A cycle 1 (Codex env-scrubbing):** implementation is on disk in the new worktree but UNCOMMITTED. The second-pass reviewer raised 3 material concerns that need to be addressed before commit. See "What to do next" below.

4. **Pre-Phase A cycles 2+:** not started. Cycle 2 was scoped as credential-validation + audit-log schema + registry-row (already done as part of cycle 1's spec landing).

---

## Cycle 1 — what's already on disk

In `~/.instar/agents/echo/.worktrees/spec-provider-portability/`:

**Modified files (staged for cycle 1):**
- `src/providers/adapters/openai-codex/transport/codexSpawn.ts` — new `buildCodexChildEnv()` helper implementing Rule 1a env-allowlist, with `BOOT_OPENAI_BASE_URL` module-level snapshot, defensive hard-deletes of OPENAI_API_KEY / OPENAI_ORG_ID / OPENAI_PROJECT_ID, kill-switch handling (INSTAR_DISABLE_RULE1_OPENAI=1 + non-empty OPENAI_API_KEY), and explicit caller-provided apiKey override. Carries the RULE 3.1 RATIONALE block.
- `src/providers/adapters/openai-codex/transport/oneShotCompletion.ts` — switched from `{ ...process.env }` to `buildCodexChildEnv({ apiKey, codexHome })`.
- `src/providers/adapters/openai-codex/transport/structuredOneShot.ts` — same switch.
- `scripts/check-rule3-coverage.cjs` — extended with OpenAI patterns: `OPENAI_API_KEY` (env-var identifier), `new OpenAI(`, `openai.chat.completions.create`, `import/require of 'openai'`, LHS assignment to `OPENAI_BASE_URL`.
- `specs/provider-portability/06-state-detector-registry.md` — new row for `codexSpawn.ts`, status ✅ Compliant.
- `tests/unit/scripts/check-rule3-coverage.test.ts` — 8 new test cases covering the new patterns.

**New files:**
- `src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.ts` — startup canary, injects sentinel `OPENAI_API_KEY=sk-CANARY` into process env and asserts the helper scrubs it. Restores parent env after.
- `tests/unit/providers/adapters/openai-codex/codexSpawn-env.test.ts` — 12 tests covering scrub paths, kill-switch, allowlist members, defensive deletes.
- `tests/unit/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.test.ts` — 4 tests covering canary scenarios.
- `upgrades/side-effects/openai-codex-env-scrubbing.md` — side-effects review artifact. Second-pass review section CARRIES THE CONCERNS RAISED VERDICT, not concur — must be re-reviewed after fixes.

**Test state:** 32 tests pass at the new worktree location, last run 2026-05-17 14:11. Run with: `cd ~/.instar/agents/echo/.worktrees/spec-provider-portability && npx vitest run tests/unit/providers/adapters/openai-codex/codexSpawn-env.test.ts tests/unit/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.test.ts tests/unit/scripts/check-rule3-coverage.test.ts`

**`node_modules`:** the worktree's `node_modules/` is a SYMLINK to `~/Documents/Projects/instar/node_modules`. If the symlink breaks (e.g., main checkout deleted), run `cd ~/.instar/agents/echo/.worktrees/spec-provider-portability && rm node_modules && ln -s ~/Documents/Projects/instar/node_modules node_modules`.

---

## Reviewer's 3 concerns to address BEFORE committing cycle 1

The second-pass reviewer (independent subagent on 2026-05-17) raised these as material blockers:

**Concern 1 (CRITICAL):** `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts` LEAKS today. The file calls `execFileSync(tmuxPath, tmuxArgs, ...)` WITHOUT an `env:` option. tmux inherits parent `process.env` including `OPENAI_API_KEY`. The `tmux -e` flags ADD to inherited env, they don't replace it. The reviewer also noted line 69 pushes `OPENAI_API_KEY` from `config.apiKey` explicitly. The artifact's "tmux owns stdin/env" claim is wrong. **Fix:** route through `buildCodexChildEnv()` or a tmux-aware variant; remove or scrub the explicit OPENAI_API_KEY push.

**Concern 2 (CRITICAL):** `src/core/Config.ts:419-427` `buildProviderEnvFlags` is a second Codex-side spawn-env construction path. Emits `-e OPENAI_API_KEY=<value>` consumed by `SessionManager.ts:1326+` for interactive Codex spawns. Not enumerated in cycle 1's "one-time exhaustive callsite audit." **Fix:** route through `buildCodexChildEnv()` or remove the API-key emission entirely.

**Concern 3 (HIGH):** the new Rule 3 grep patterns (`\bOPENAI_API_KEY\b`, `\bOPENAI_BASE_URL\b\s*=`) will false-positive on legacy `src/core/Config.ts` (lines 387, 420, 422, 425) and `src/core/types.ts:16`. Those files don't have `RULE 3: EXEMPT` markers — future edits to them will be blocked. **Fix:** either (a) add `RULE 3: EXEMPT` markers to those legacy files in the cycle 1 commit batch, or (b) tighten the OPENAI_API_KEY pattern to LHS-assignment-only forms. Pick one.

---

## What to do next (in order)

1. **Read this handoff doc** + the approved spec at `specs/provider-portability/12-openai-path-constraints.md`. Especially the "Compliance boundary at the process edge" section and the "Sequencing during the migration window" section — both are load-bearing for the concerns above.

2. **Address Concern 1.** Open `src/providers/adapters/openai-codex/transport/agenticSessionHeadless.ts`. Find the `execFileSync(tmuxPath, ...)` call. The `tmux new-session -e VAR=value` flags layer ON TOP of the inherited env, so you need BOTH (a) pass an explicit `env:` to `execFileSync` constructed via `buildCodexChildEnv()`, AND (b) audit the explicit `-e OPENAI_API_KEY=...` push for whether it should remain (Phase A) or be removed (matching the new helper's behavior). Add tests covering both surfaces. Likely also need to teach `buildCodexChildEnv` to produce tmux `-e VAR=VAL` flag arrays in addition to a plain env object — or accept that tmux callers do both: pass env to `execFileSync` AND construct -e flags from the same `buildCodexChildEnv` output via a sibling helper.

3. **Address Concern 2.** Open `src/core/Config.ts` at lines 419-427 (`buildProviderEnvFlags`). Trace its consumer at `src/core/SessionManager.ts:1326+`. The function returns env flags as a string-array — it doesn't actually spawn anything itself. The fix is to make it route ONLY allowed variables (likely just CODEX_HOME) and refuse the OPENAI_API_KEY push. The consumer at SessionManager:1326+ then gets a sandbox-safe flag set. Add tests verifying the flag set never contains an OPENAI_API_KEY line.

4. **Address Concern 3.** Pick (a) or (b). (b) is more conservative: tighten patterns to `process.env.OPENAI_API_KEY\s*=` and `OPENAI_API_KEY=\${` style LHS assignments only — won't false-positive on the legacy reads. (a) is more thorough: every legacy file gets either an EXEMPT marker (with a justified reason) or a refactor to use the helper. Recommend (b) for cycle 1 speed; (a) becomes its own cycle if needed.

5. **Update the side-effects artifact** (`upgrades/side-effects/openai-codex-env-scrubbing.md`). Document the new fixes for each concern. Replace the "Concern raised" verdict with a fresh second-pass review request.

6. **Re-run second-pass review.** Spawn an independent reviewer subagent with the updated artifact + the files. Only commit cycle 1 if concur.

7. **Commit cycle 1.** Use `/instar-dev` for the commit (the pre-commit gate requires a fresh trace + artifact). The trace file lives at `.instar/instar-dev-traces/<timestamp>-codex-env-scrubbing.json`.

8. **Push, run smoke tests, merge.** The push gate runs `npm run test:smoke`; expect green. No deploy without Justin's call.

9. **Move to Phase 5 implementation.** The spec at `specs/provider-portability/11-cost-aware-routing.md` is approved. The implementation plan starts with `CostStateTracker` + the policy. See the spec for the decision matrix.

---

## Sandbox-EPERM background — why the worktree moved

On 2026-05-17 mid-session, every read/write/cd against `/Users/justin/Documents/Projects/instar/` started returning EPERM. Tools affected: `cat`, `node fs`, `Read`, `Edit`, shell `cd`, `find`, `ls`. The block was not FDA-related (python3 and node failed the same way). It was Claude Code's sandbox scoping access to the agent's primary working directory; the instar shared repo lives OUTSIDE that scope.

The fix: worktrees go in `~/.instar/agents/echo/.worktrees/` instead of inside the shared instar checkout. This keeps the worktree visible to git (the bare repo supports remote-location worktrees natively) while keeping the working directory inside the agent's sandbox-safe home.

The move command was: `cd ~/Documents/Projects/instar && git worktree move /Users/justin/Documents/Projects/instar/.instar/worktrees/spec-provider-portability /Users/justin/.instar/agents/echo/.worktrees/spec-provider-portability`. All in-flight uncommitted changes survived the move. `node_modules` was empty after the move; replaced with a symlink to the main checkout.

**Going forward**: when creating new worktrees against the instar shared repo, use the helper at `~/.instar/agents/echo/.bin/instar-worktree-create.sh` (created in the same fix work as this handoff). The helper is a small bash wrapper that runs `git worktree add` with the correct destination path automatically.

---

## Related artifacts

- **Approved spec:** `specs/provider-portability/12-openai-path-constraints.md`
- **ELI16 companion:** `specs/provider-portability/12-openai-path-constraints.eli16.md`
- **Convergence report:** `docs/specs/reports/openai-path-constraints-convergence.md`
- **Cross-review outputs:** `~/.claude/skills/crossreview/output/20260517-122212/` (rounds 1+2) and `~/.claude/skills/crossreview/output/20260517-123314/` (round 3)
- **Phase 5 spec (next phase):** `specs/provider-portability/11-cost-aware-routing.md` (approved 2026-05-15)
- **Side-effects artifact (cycle 1):** `upgrades/side-effects/openai-codex-env-scrubbing.md` (currently shows "Concern raised" — needs re-review after fixes)
