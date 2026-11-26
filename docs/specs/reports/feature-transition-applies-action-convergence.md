# Convergence Report — Feature switches apply their setting, and say honestly whether it is running

Spec: `docs/specs/feature-transition-applies-action.md` · ELI16: `docs/specs/feature-transition-applies-action.eli16.md` · Issue: `docs/issues/feature-switch-never-applies-enable-action.md` (Echo Bugs topic 10000000857)

## Cross-model review: codex-cli:gpt-6-astra + gemini-cli:gemini-4-argon (RAN — three rounds each)

Every round was a real cross-family pass: GPT-6 Astra (codex CLI, reading the worktree and running small isolated probes of the actual functions) and Gemini 4 Argon (gemini CLI, the spec + the relevant code regions on stdin). Reports: `docs/specs/reports/feature-transition-applies-action-spec-r{1,2,3}-{astra,argon}.md`.

| Round | Astra | Argon | What changed the build |
|---|---|---|---|
| 1 | not ready (8) | ready with changes (6) | Two actions wrote keys nothing reads (threadline.relayEnabled, evolution.approvalMode); default-on features read as off; "on and running" unsupported; consent flow; concurrency; merge precedence; failed attempts vanishing; security claims narrowed; `/apply` route + duplicate column cut |
| 2 | ready with changes (6) | ready with changes (3 bugs) | Prerequisite rule (taken from r1) dropped — the evolution consumers do not honor it; autonomy-profile resolver; evolution-system read-only; expired proof → 401; telemetry disable reordered; shallow merge → one level deep; object-without-`enabled` → defaultOn; dashboard always shows the sentence |
| 3 | ready with changes (4, display only) | ready (2 doc nits) | Threadline env-override note; undo notes qualified with the restart; detail panel re-renders; read-only switch in the detail view |

Convergence: round 3 changed only wording and two dashboard renderings; no architectural, security or honesty-of-state finding remained. That is the 80/20 convergence bar (findings stopped changing the build), so no round 4 was run.

## ELI10 Overview

The dashboard's feature switches wrote down the operator's choice and did nothing else: the agent's real setting never changed, and the next restart quietly flipped the switch back. The fix makes the switch send the feature's own setting change through the server's existing, already-guarded route, remember the answer, and tell the truth on the page — "on in the settings", "saved, starts after a restart", or "switched on but refused, because …". Flipping the switch with a fresh PIN unlock counts as the person's consent, which the old design had no way to collect from a dashboard. Reviewers found that two switches wrote settings nothing read, that six features were shown "off" while running, and that one feature's setting is ignored by the agent entirely — so that one is now shown read-only instead of pretending.

## Original vs Converged

- **Originally**, the action was applied and the shown state said "On and running." **After review**, "on" says the setting was on at start and that running is not separately verified; no boot snapshot is ever invented (`atBoot: null`).
- **Originally**, a loopback client with any `/`-prefixed path and a separate `/apply` retry route. **After review**, four exact method/path pairs, no redirects, no retry route (the operator switch re-applies), one nullable result column.
- **Originally**, the definitions were trusted. **After review**, Threadline writes `relayEnabled`, Autonomous Evolution writes `approvalMode` (resolved through the autonomy profile exactly as the consumer does), six features are `defaultOn`, the tunnel body no longer overwrites a named tunnel, evolution-system is `switchable: false`, and every undo note says what `PATCH /config` can actually do.
- **Originally**, a forged or expired operator proof fell back silently to the agent path. **After review**, it answers 401 `OPERATOR_PROOF_INVALID` and the dashboard re-unlocks once.
- **Originally**, two concurrent switches could interleave. **After review**, a per-feature serial queue, with the one route that awaited a remote call (telemetry disable) reordered so its local writes finish first.

## Standards-Conformance Gate

Signal vs authority: the applier is a client of routes that already hold the authority; the operator path removes a block for a verified principal using the existing PIN proof; no new detector, no brittle blocking logic. Multi-machine posture: machine-local by design (config, discovery.db and the boot snapshot are per machine). Three test tiers: unit (applier, registry, migration), integration (real listening app), e2e (production AgentServer + real PIN unlock + real config.json flip + restart keeps the switch).
