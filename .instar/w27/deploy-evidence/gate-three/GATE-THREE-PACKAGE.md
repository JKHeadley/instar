# Window 27 Gate-Three Package

Status: assembled for Observer 1 row 58070 / Observer 2 pre-deploy review. No release steps have been performed.

## Exact Deploy Candidate

- Candidate clone: `/Users/justin/.instar/agents/echo/.instar/w27/candidate-worktree-20260825T234424Z`
- Candidate HEAD: `bd24507b56afb7fd19e3f4a89c930ba7a2ebeb45`
- Candidate status: candidate regression-green by evidence.
- Candidate evidence package: `.instar/w27/candidate-worktree-20260825T234424Z/.instar/w27/deploy-evidence/candidate/CANDIDATE-GREEN-EVIDENCE.md`
- Composition status: `.instar/w27/candidate-worktree-20260825T234424Z/.instar/w27/deploy-evidence/candidate/COMPOSE-STATUS.md`
- Staging status at adoption: `git diff --cached --name-only` returned empty.

Changed candidate files:

- Authoritative source/test/doc list regenerated mechanically against committed base `bd24507b56afb7fd19e3f4a89c930ba7a2ebeb45`.
- Exact command sequence used:
  - `TMP_INDEX=/private/tmp/w27-gate3-authoritative-20260826T055442Z.index`
  - `GIT_INDEX_FILE="$TMP_INDEX" git read-tree bd24507b56afb7fd19e3f4a89c930ba7a2ebeb45`
  - `GIT_INDEX_FILE="$TMP_INDEX" git add -N docs src tests upgrades`
  - `GIT_INDEX_FILE="$TMP_INDEX" git diff --name-only bd24507b56afb7fd19e3f4a89c930ba7a2ebeb45 -- docs src tests upgrades`
- Resulting file count: 30.
- Observer 2 named-file confirmation: `src/server/sessionSpawnTopicBinding.ts`, `tests/unit/session-spawn-topic-binding.test.ts`, `tests/unit/job-toggle-route-must-fail.test.ts`, and `tests/integration/scheduler-live-state-lifecycle.test.ts` all appear in the regenerated list.

- `docs/specs/w27-between-window-admission-gate.eli16.md`
- `src/cli.ts`
- `src/commands/gate.ts`
- `src/commands/server.ts`
- `src/core/BetweenWindowAdmissionGate.ts`
- `src/core/CartographerTree.ts`
- `src/core/TelegramRelay.ts`
- `src/providers/adapters/gemini-cli/transport/geminiSpawn.ts`
- `src/remediation/audit/AuditProjection.ts`
- `src/scheduler/JobScheduler.ts`
- `src/server/CapabilityIndex.ts`
- `src/server/routes.ts`
- `src/server/sessionSpawnTopicBinding.ts`
- `tests/e2e/between-window-admission-lifecycle.test.ts`
- `tests/e2e/gemini-cli-alive-lifecycle.test.ts`
- `tests/e2e/gemini-setup-narrative-lifecycle.test.ts`
- `tests/helpers/betweenWindowAdmissionFixture.ts`
- `tests/helpers/setup.ts`
- `tests/integration/between-window-admission-route.test.ts`
- `tests/integration/scheduler-live-state-lifecycle.test.ts`
- `tests/unit/JobScheduler.test.ts`
- `tests/unit/NovelFailureReviewer.test.ts`
- `tests/unit/between-window-admission-gate.test.ts`
- `tests/unit/gemini-cli-adapter.test.ts`
- `tests/unit/job-toggle-route-must-fail.test.ts`
- `tests/unit/relay-kind-forward.test.ts`
- `tests/unit/session-pool-activation-wiring.test.ts`
- `tests/unit/session-spawn-topic-binding.test.ts`
- `tests/unit/telegram-relay-timeout-observability.test.ts`
- `upgrades/side-effects/w27-between-window-admission-gate.md`

## Findings List

Canonical findings list for this gate package:

- `.instar/w27/WINDOW-FINDINGS.md`

Required carried items from Observer 1 row 58070:

- Claim wording: candidate regression-green by evidence.
- Suite-certification finding: this laptop cannot produce a clean certifying full-suite run for base or candidate under current conditions.
- Wake-socket long-temp-path EINVAL: pre-existing. Owner: unowned — needs owner.
- Lane 2 listener-proof substitution: explicit evidence limitation.

Additional lifecycle finding:

- Predecessor `echo-w27-pathway-2` exited without a terminal topic row after row 58057. The reap-log/session-lifecycle record caught the truth (`process-exited` at `2026-08-26T05:01:24.536Z`), but the run's own record had no end marker. This gap is lane-1 subject matter.

## Charter Item 1 Evidence: State Lifecycle Truth

Evidence artifact:

- `.instar/w27/lane1-worktree/.instar/w27/deploy-evidence/lane1/state-lifecycle-candidate-evidence.md`

Mapped proofs:

- Job manifest/body refresh before admission: `JobScheduler.triggerJob()` refreshes the job snapshot immediately before admission, and unit coverage proves JSON and AgentMD bodies are re-read without scheduler restart.
- Disable admission truth: `PATCH /jobs/:slug` writes config, refreshes live scheduler state, and refuses if the live scheduler still reports the old enabled flag.
- Trigger refusal truth: `POST /jobs/:slug/trigger` and dashboard run now return HTTP 409 when the live scheduler refuses admission as skipped.
- Scheduled-tick proof: integration coverage disables a per-second scheduled job through the route and proves no session spawn occurs through the next tick window.
- Terminal ordering: `notifyJobComplete()` saves authoritative state before recording terminal run-history completion.
- Teardown ownership: startup missed-job timers are owned and cleared on `stop()`.

Lane 1 verification:

- `npx vitest run --cache=false tests/unit/job-toggle-route-must-fail.test.ts --reporter=verbose`: exit 0, 3 tests.
- `npx vitest run --cache=false tests/unit/JobScheduler.test.ts tests/unit/job-toggle-route-must-fail.test.ts`: exit 0, 42 tests.
- `npx vitest run --cache=false --config vitest.integration.config.ts tests/integration/scheduler-live-state-lifecycle.test.ts`: exit 0, 3 tests.
- `npm run build`: exit 0.

Lane 1 limitation:

- Supertest route checks were replaced by in-process Express router invocation where the sandbox refused listener binds with `listen EPERM`.

## Charter Item 2 Evidence: Admission And Delivery Truth Under Saturation

Evidence artifact:

- `.instar/w27/lane2-worktree/.instar/w27/deploy-evidence/lane2/candidate-status-2026-08-25.md`

Mapped proofs:

- Rerouted cap refusal is surfaced: `JobScheduler` preserves spawn-error audit rows and emits visible terminal retry-next-trigger activity metadata.
- Lane/orchestrator/pathway spawns are topic-bound or refused: `/sessions/spawn` requires `topicId`, passes it into `SessionManager.spawnSession`, and binds the resulting session to the topic through `TelegramAdapter.registerTopicSession` or the disk fallback.
- Stored/woken-but-never-consumed no longer reports success in touched paths: false returns from `injectTelegramMessage` stop delivery confirmation or record inject error.
- Relay "sent" requires destination-store confirmation: `/telegram/reply/:topicId` checks destination topic history, reports `destinationStoreConfirmed`, and tokenless relay rejects holder responses without that confirmation.
- Studio live opening-control evidence exposed the fleet-consumer gap: returned relay message id `57631` was present in the Studio store but absent from the laptop store during the worker's reads, proving message id alone is insufficient destination-store evidence.

Lane 2 verification:

- `npx vitest run --cache=false tests/unit/telegram-relay-timeout-observability.test.ts tests/unit/session-spawn-topic-binding.test.ts`: exit 0, 14 tests.
- `npx vitest run --cache=false tests/unit/headless-spawn-reroute.test.ts tests/unit/JobScheduler.test.ts tests/unit/JobRunHistory.test.ts tests/unit/telegram-tokenless-relay.test.ts tests/unit/session-telegram-inject.test.ts`: exit 0, 102 tests.
- `npx vitest run --cache=false tests/unit/JobScheduler.test.ts tests/unit/telegram-relay-timeout-observability.test.ts tests/unit/session-spawn-topic-binding.test.ts`: exit 0, 50 tests.
- `git diff --check`: exit 0.
- `npm run build`: exit 0.

Lane 2 explicit evidence limitation:

- Lane 2 listener-proof substitution: explicit evidence limitation.
- HTTP listener route/E2E proof could not run in this sandbox because local listeners are refused with `EPERM listen`; the accepted proof is helper/unit coverage plus destination-store evidence, not listener-backed proof.

## Migration, Template, And Agent-Awareness Parity

Restated against the authoritative 30-file changed-candidate list above:

- No files under `src/migrations`, migration manifests, scaffold templates, template scripts, or agent-installed template directories appear in the regenerated list.
- Therefore no migration artifact, template copy, or installed-agent template parity update is claimed or required by this candidate package.

Agent-awareness and command-surface parity where the candidate touches installed/operator surfaces:

- `src/cli.ts` wires `instar gate between-window --package <path>` into the CLI.
- `src/commands/gate.ts` implements the command by calling `evaluateBetweenWindowAdmission`.
- `src/server/CapabilityIndex.ts` classifies `/gate` as internal operator admission machinery so the capability surface does not claim it as a user/agent runtime capability.
- `src/commands/server.ts`, `src/core/TelegramRelay.ts`, `src/server/routes.ts`, and `src/server/sessionSpawnTopicBinding.ts` carry the topic-binding and destination-store-confirmation behavior used by the agent communication surfaces.
- `docs/specs/w27-between-window-admission-gate.eli16.md` and `upgrades/side-effects/w27-between-window-admission-gate.md` carry the operator/reviewer-facing explanation for the new between-window gate surface.
- The corrected list includes the route and lifecycle tests proving the agent-facing control-plane behavior: `tests/unit/session-spawn-topic-binding.test.ts`, `tests/unit/job-toggle-route-must-fail.test.ts`, and `tests/integration/scheduler-live-state-lifecycle.test.ts`.
- No package or template migration is claimed; none is present in the authoritative touched file set.

## Plan-Page And Close-Gate Receipts

Plan-page input receipt from the active charter:

- Canonical plan page: `Where this project stands`
- View id: `3a08766f-5738-474f-8857-b713f753a7e2`
- Last updated when read for this window: `2026-08-25T05:15:26Z`
- Current-work node read at opening: `Window 27: the between-window re-ground (not yet chartered)`
- Charter reference: `.instar/w27/CHARTER.md`, line 5.

Plan-page output and close-gate receipt:

- Pending. Row 58070 authorizes only gate-three package assembly and then hold.
- No plan-page result write, close-gate pass, end reaffirmation, release step, or deployment is claimed by this package.

## Hold Boundary

Pathway must now post one topic row naming this package path and then hold. Observer 1 spawns the fresh Observer 2 pre-deploy review for gate three.
