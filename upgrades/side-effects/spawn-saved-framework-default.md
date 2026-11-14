# Saved framework model at headless spawn

## Summary
Tier 1, narrow reversible bug fix for fb-d4cae51f-16b / topic 10000002384. Five files; final LOC recorded in PR. One independent review round; commit/gate attempts recorded in PR.

## Decision points touched
Model precedence in SessionManager.spawnSessionInternal is modified: explicit request, saved default for resolved headless framework, existing launcher fallback. No information-flow block/allow or detector authority is added. Build grounded in fresh origin/main 8d81ecb24, version 1.3.1719, origin https://github.com/JKHeadley/instar.git. A temporary clone hosts a fresh worktree because supplied checkout metadata is sandbox read-only; agent identity is echo@instar.local.

## 1. Over-block
No block/allow surface. Explicit raw models and tiers continue to launch unchanged. No new input rejection.

## 2. Under-block
No block/allow surface. Existing model validation and invalid saved configuration handling are unchanged. Tests exercise actual launch arguments and persisted state.

## 3. Level-of-abstraction fit
The session launch boundary owns this fallback, matching interactive spawning. Resolving after framework fallback prevents reading the wrong framework's default. No duplicate default registry is introduced.

## 4. Signal vs authority compliance
No block/allow surface; complies with docs/signal-vs-authority.md. This is enumerable configuration precedence, not a detector acting as authority.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. A caller's explicit model wins over saved configuration; no live signals compete.

## 5. Interactions
Explicit job and internal judge tiers remain authoritative, including balanced. useAgentDefaultModel now reaches the same saved framework model as an omitted request. Codex quota swaps and CLI compatibility checks still receive the effective request. Both rerouted Claude and ordinary headless paths share the resolved result. No additional disk I/O, timers, state mutation, double-fire or race.

## 6. External surfaces
New sessions without explicit models use the operator's saved choice. Session metadata records the effective model as before. No API schema changes, new notices, persistent state, generated URLs, or operator actions. Existing processes are unaffected.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Machine-local BY DESIGN: spawning uses the framework default in the launching machine's existing SessionManager configuration, just like interactive sessions. This patch creates no durable state, changes no replication contract, emits no notices, and generates no URLs. Topic transfer reads the destination's existing configuration. No status/health/capabilities/channels answers change.

## 8. Rollback cost
Revert and ship a patch. No settings rewrite, migration or state repair. New omitted-model spawns would return to the previous launcher fallback.

## Conclusion
The fallback is confined to model selection before existing launch-model handling. Explicit balanced mapping is untouched. Regression coverage checks argv and stored session metadata.

## Second-pass review
**Reviewer:** review_spawn_default (independent agent)

**Independent read of the artifact: concur.** The fallback uses the actual resolved framework and runs before existing Codex quota/compatibility handling and Claude interactive rerouting. Explicit models, including balanced, bypass the saved default; the tier mapping is unchanged. Reviewed the inherited-framework regression and temporary config-home fixture repair. Independently ran behavioral, triage, and Threadline spawn suites after those changes: all 73 tests passed, including six new launch-boundary cases. No blocking authority, state migration, or lifecycle side effects identified.

## Evidence pointers
Corrected regression run before fix: two failures (omitted Codex and Claude defaults), three passing explicit/fallback cases. /tmp/instar-default-red.log. After fix: 73 unit tests pass across behavioral, triage and Threadline MCP spawn suites; 15 integration tests pass across model-resolution and sessions-spawn-topic-profile suites. Existing transcript fixtures now use a temporary session config home so this same file can run in the sandbox without writing the real Claude home.

## Class-Closure Declaration
No agent-authored-artifact defect — not applicable. This changes runtime configuration selection, not an agent-authored prompt, hook, skill, controller or standards text.
