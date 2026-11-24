---
audit: test-host-state-isolation
target-pattern: Tests that accidentally depend on mutable real home or host state.
search-surface: All 6031 tracked files under tests at ec9401e5, plus configuration and production dependency call paths.
status: Round 1 incomplete. No convergence claim.
standing-guard: Pending. A future ratchet must detect factory-backed fake-provider tests lacking an owned host-state fixture.
blind-spot-class: A temporary project directory does not isolate process singleton and home-derived host ledgers.
standard-response-kind: no-change
standard-response-ref: docs/STANDARDS.md
standard-response-article-id: test-identity-never-enters-production-state
standard-response-article: Test Identity Never Enters Production State
standard-response-rationale: The existing throwaway-home principle already covers these fixtures; implementation coverage remains incomplete.
---

# Test Host State Isolation Audit

This is a source investigation, not a test result. No source fixes or executable tests have run. The baseline is ec9401e5bdf28ed5ab1ff13f88e0032cc7895fc6. The two priority findings below are unchanged in published candidate 01bd1cce6fc80f1d66eda2c27e3aaa761381cf83, as confirmed by a Git diff of their exact paths.

## Surface and method

The ledger retains all 6031 tracked files under tests. Name searches found 547 candidates. Content searches covered ambient home use (108 files), framework home settings (1955 files), host ledgers (26 files), native factories (34 files), singleton resets (47 files), home spies (21 files), and real-system opt-in markers (89 files). These groups overlap. Structure review follows test setup, real factory wrappers, singleton initialization, path resolution, and teardown. Raw searches and the ranked candidate index are in .instar/state/build. These counts describe search coverage, not reviewed or safe files.

Buckets are F for a demonstrated fixture isolation defect, S for a fixture with source-proven isolation, R for an intentional real-system test, O for inert construction or dependency context, and U for an unresolved call path. No generic home replacement is authorized for real native work. A private admission ledger for real processes would undermine host safety.

## Round 1 findings

| Location | Behavior and bucket | Smallest next action |
| --- | --- | --- |
| tests/e2e/spawn-cap-forkbomb-lifecycle.test.ts:45-68 | F. configureHostSpawnSemaphore({}) runs without an owned home, then GET /spawn-limiter asserts saturated is false. HostSpawnSemaphore derives its holder file from os.homedir()/.instar/host-spawn-holders.json. The temporary route stateDir does not scope that file. | Scope home to a temporary fixture before configuration, reset the singleton before and after the fixture, close the HTTP server, and restore the spy. Preserve the ordinary cap and route assertions. |
| tests/e2e/provider-substrate-live-wiring.test.ts:62-107,166-189 | F. A temporary project and a fake pool do not isolate the real factory spawn-cap wrapper. evaluate() acquires the real home-derived host ledger before the fake provider runs. A child-process mock does not prevent that ledger dependency. | Give this fake-provider fixture an owned home and reset the host semaphore at its boundaries. Preserve the real factory and wrapper assertions. |
| tests/e2e/gemini-cli-alive-lifecycle.test.ts:75-107 | R. This deliberately invokes an installed native Gemini provider. Its real admission dependency is appropriate. | Keep real host admission. Any explicit smoke-test opt-in policy is a separate design decision. Do not apply a private ledger to real native work. |
| tests/e2e/test-runner-limiter-lifecycle.test.ts:61-119 | S. It saves relevant environment variables, sets INSTAR_HOST_TEST_BASE_DIR to an owned temporary directory before reset and server initialization, then restores environment and singleton state. | No fixture fix indicated by the reviewed call path. |
| tests/integration/test-runner-limiter-route.test.ts:94-129 | S. It scopes the host-test base directory, resets singleton and prune state, and terminates only its own fixture children before restoring variables. | No fixture fix indicated by the reviewed call path. |
| tests/e2e/gemini-capacity-policy-lifecycle.test.ts | S. It invokes owned fake binaries directly and resets the policy singleton. Persistence occurs only with an explicit quotaStateFile, which the persistence case places under its temporary directory. | No home-spy requirement is justified here. |
| tests/integration/gemini-cli-provider.test.ts:60-100 | O. Factory construction is inspected without evaluating a provider. | Do not classify a host-ledger write solely from factory construction. |
| tests/integration/model-resolution.test.ts:18-107 | S. Direct provider execution uses a scoped child-process mock, with no factory admission wrapper. | No host-ledger fix indicated by this call path. |
| tests/integration/llm-circuit-breaker-chokepoint.test.ts and stale-process-login-expired fixtures | Known baseline candidates already addressed by published PR 3709. | Retain their baseline classification and verify the published exact diff before proposing any duplicate work. |

New confirmed defects this round: 2. Other indexed candidates remain unresolved. The audit has not converged.

## Safe regression strategy

The first independent repair should cover the two fake-provider and read-only-route fixtures above. Before implementation, freeze an isolated branch and a focused plan through the parent and verification coordinator. Reproduce dependence using an owned fake home with a deliberately saturated private ledger and the current ordinary bound; never write the live ledger. The corrected fixture must restore singleton state and home spies, keep both saturated and available behavior meaningful, and leave native-provider smoke tests under real admission. No execution is authorized by this document.

## Meta-insight

How it arose: Host admission was introduced below provider factories. Existing tests that owned their project state or mocked physical process creation consequently gained a new home-derived filesystem dependency without changing their visible fixture setup.

Why prior controls missed it: Project stateDir isolation and process mocks look sufficient when inspected locally. The missing boundary appears only when following the factory wrapper into the process singleton and its home-derived ledger. The existing throwaway-home standard expresses the right rule, but there is no demonstrated structural ratchet covering this class of factory fixture.

## Convergence plan

Continue content and call-path classification across every indexed framework, setup helper, and singleton dependency. Fix or explicitly classify findings with evidence, then repeat name, content, and structure searches over the expanded surface. Only a clean full resweep with zero new findings and no unresolved defects can support convergence. Do not stamp convergence now.

## Urgent Shared Checkout Expansion

The surface now includes shared authored constitution writes. A confirmed third defect is tests/unit/standards-registry-asset.test.ts:774, which temporarily appends one real article to the checkout registry while a separate unit test reads its live total. Exact source and the safe fixture-only proposal are preserved in .instar/state/build/standards-shared-writer/finding.md. This has priority over the two host-ledger fixtures. No temporal reproduction or historical cause is claimed.

## Direct singleton acquisition sweep after the registry repair

A search for the singleton getter, configurator and resetter at the verified 01bd head found seven directly referencing test files. In tests/integration/spawn-cap.test.ts the suite creates a temporary holdersPath at line 64, but the HTTP saturation case at lines 87–99 configures the production singleton and calls acquire twice without passing that path. Later wrapper cases pass holdersPath explicitly. The HTTP case can write the default host ledger and attribute saturation to other processes; resetting the singleton forgets its reference without releasing either acquired holder. The HTTP route and the two genuine acquisitions should use the same private fixture home, assert both acquisition results and release the owned holders. Real subprocess admission for the test runner must remain intact.

This finding expands the earlier two host-ledger fixture findings. It is source evidence of a shared writer. No assertion about historical host state or effects on any particular run follows from it.

## Agent registration fixture

The registerConnectedAgent group in tests/unit/agent-connector.test.ts constructs its path from HOME at module load. Its beforeEach saves and unlinks the user's .instar/registry.json, and its afterEach overwrites that path with its saved bytes or removes it again. src/core/AgentConnector.ts binds the production path the same way. Unit setup isolates CODEX_HOME, which is a different variable. In runs inheriting the operator's home, a concurrent registry update could therefore be lost. No live probe or historical destructive baseline is necessary. The independent fixture repair is assigned to main_search_failure_review.

## Continued Shared State Search

Confirmed additional defect: agent-connector.test.ts:313-342 temporarily unlinks and restores the real HOME-derived agent registry. Exact source and the module-import timing constraint are preserved in .instar/state/build/agent-connector-live-registry/finding.md. This requires a separate small fixture repair; no live baseline is authorized. The audit remains incomplete and has not converged.

## Further Framework Classification

Two more confirmed fake-provider host-ledger coupling defects remain unresolved: tests/integration/internal-codex-account-room.test.ts and tests/e2e/internal-codex-reset-first-lifecycle.test.ts. Exact source evidence is in .instar/state/build/codex-fake-provider-host-ledgers/finding.md. Their owned account pools and CODEX_HOME handling do not isolate the real factory admission wrapper. They are separate from the frozen three-file fixture group.

The live Codex usage canary is an intentional real-native provider test with documented environmental skip semantics; retain its explicit real-system classification and inspect any admission policy separately rather than applying a fake-work private ledger. claude-forbidden-guard.test.ts resets only a process-local boolean/reason at both test boundaries; reviewed production guard has no persistence. The mocked-child CodexCliIntelligenceProvider account unit tests restore CODEX_HOME and do not invoke the real factory. These bounded classifications do not close all remaining framework-home or singleton candidates.

## Setup Lock Import-Time Capture

Discovery.test.ts and discovery-pipeline.test.ts explicitly delete and overwrite the home-derived setup lock captured before their homedir mocks. Exact evidence is in .instar/state/build/discovery-live-setup-lock/finding.md; root is routing this to the existing import-time-home repair owner. AgentRegistry tests differ: the production registry path is resolved lazily, so their scoped homedir spy controls each operation despite an outdated comment about module cache. No global all-safe conclusion follows.

## Ambient Authentication Boundary

Two direct-Claude fixture files have conditional inherited-auth coupling: ClaudeCliIntelligenceProvider-key.test.ts and claudeReviewerLogin.test.ts. Their ordinary no-auth cases can inherit a token that the fake binary interprets as success; the key fixture can also write that value to its owned temporary seen file. Exact source-only proof is in .instar/state/build/ambient-claude-auth-fixtures/finding.md. No actual credential values or historical exposure were inspected or claimed. These stay separate from the frozen host-ledger group.

## Current Parent Surface Expansion

The original 6031 tracked test files remain in scope. Parent c21 adds five tracked test/helper/setup files, expanding the current population to 6036. Their exact list is in .instar/state/build/current-parent-surface.json. The module-path structural search adds 30 candidates beyond the original 34 content candidates at this parent, including the new already-owned circuit-breaker lifecycle. Type-only imports do not prove that transitive component defaults avoid a real factory; those call paths remain open. Neither candidate classification nor known parent review counts as overall convergence.

## Checkpoint for handoff

The companion directory test-host-state-isolation-evidence contains the five finding notes, the proposed follow-up check, and the early registry fixture patch. The patch preserves the prototype for reference. The reviewed replacement for that prototype landed in PR 3731. This branch preserves the investigation at its original baseline and makes no new test or convergence claim.
