# Side-Effects Review — Feedback executor, phase 2 (confined fix attempts, review-gated merge)

**Version / slug:** `feedback-execute-phase2`
**Date:** `2026-10-09`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagents (see below)`

## Summary of the change

Implements §4 of `docs/specs/feedback-triage-and-execution.md` (the executor), on top of Phase 1 (PR #2143). New code lives in `src/feedback-factory/execute/`:

- `FeedbackExecutorService` — per tick: availability (approver independence, auto-merge allowed, source checkout, sandbox runtime, canary/deps latches), reconcile live attempts (lease, disk cap, finished sessions → verification), drive open PRs through the review gate, follow merged fixes through release + 30 quiet days (+ live proof), then start new attempts within admission limits.
- `FeedbackExecuteStore` — the `execution` table in `feedback-drain.db`, written only under the triage store's owner-epoch fence; CAS claim with a 6 h lease and a durable daily start count.
- `executePolicy` — the ONE confinement policy, rendered as a Claude Code `--settings` file and as a sandbox-runtime settings file; the tooling/protected path list; config resolution (dry-run by default).
- `ConfinedRunner` — every executor-run command (base check, head check, lint, related tests, canary probes, native rebuild) runs through `@anthropic-ai/sandbox-runtime` (new dependency, pinned exactly to 0.0.77, three weeks old), with a scrubbed environment, a 20 min wall clock and a 5 MB output cap; refuses when the pinned runtime does not resolve.
- `confinementCanary` — must-fail / must-succeed probes before every attempt on both application paths, judged by trusted observation (nonce never seen, no file outside, `.git/config` hash unchanged, a localhost listener sees nothing), plus the full lint + unit smoke once per canary stamp.
- `changeSet` — lstat walk of the session workspace, byte comparison against the publish clone, special-file refusal, 200 files / 2 MB caps, diff gate (tooling/protected paths), secret gate (the durable credential pattern set; names only), spec-draft shape check, link-safe application into trusted clones.
- `executorPorts` — trusted git in the executor's own clones (hooks, fsmonitor, external diff, attributes, file protocol and every global/system config disabled; `--no-verify`; explicit https remote; identity forced from the resolved commit identity) and GitHub through `gh` / `safe-merge`.
- `reviewGate` — approver derivation (repository owner via the API for a user-owned repository), independence check, approval-at-head, safe-merge exit mapping, CODEOWNERS note.
- `depsCache`, `attemptFs`, `executorSession` (fixed prompt, result file, base-failure classifier), `buildFeedbackExecutor` (production wiring).

Supporting changes: `SessionManager.spawnSession` gains `cwd` (limited to `<projectDir>/.worktrees/`), `omitAuthEnv` and a `confinement` adapter (claude-code only); `SafeGitExecutor` gains a narrow `feedbackAttemptCloneOk` carve-out; `src/core/credentialEnvNames.ts`; triage service hooks (`attachExecutor`, executor holds); routes (`/feedback-factory/execute/status|tick|stop|release`, executor plan/commit actions); job `feedback-factory-execute`; config/types/dev-gate; canonical pipeline stage `execute`; write-domain entry; SelfActionGovernor class + registry entry `feedback-execute`; state-coherence registry; CapabilityIndex; dashboard executor card; CLAUDE.md template + migration.

## Decision-point inventory

- Executor admission — add — deterministic invariant (caps, epoch fence, spawn limiter, quota shedding, update pending). Enforced in executor code; the governor class is telemetry only.
- Executor outcome — add — deterministic invariant (recorded branch/PR, approval of the exact current head by the approver, `mergedAt` + `headRefOid`, lease expiry, `gh` error → unknown).
- Diff gate / secret gate — add — signals that only ever HOLD (never publish, never discard); the operator decides.
- Approver independence — add — invariant over facts (agent login, browser-profile accounts, owned identities, tagged vault entries); only a PIN-bound acceptance overrides it.
- Base-failure classification — add — deterministic reading of the confined test output; ambiguous → the check fails (no publication).
- Triage disposition — pass-through; the executor only moves items to the spec's executor hold reasons.

---

## 1. Over-block

- Every uncertainty refuses or holds: an unreadable agent GitHub login counts as "not independent"; a gh error leaves state unchanged; an unrecognised base-check failure fails the check; any special file fails the attempt; a scrub error in the secret gate holds. A real fix can therefore be held or failed for a non-defect (e.g. a test of a new export whose failure text vitest phrases differently than the classifier knows). Cost: one retry, then a hold the operator sees once.
- The approver-independence check fires on Echo today (the browser profile registry lists the repository owner), exactly as the spec predicts; the executor waits for the PIN-bound acceptance.
- Claude Code's sandbox needs its own temp area: the session's `CLAUDE_CODE_TMPDIR` is the attempt temp dir. A host where that path is too long for a unix socket would fail the canary (profile-unenforceable) rather than run unconfined.
- `dryRun` defaults to true (see deviations): until the operator flips it, nothing is attempted.

## 2. Under-block

- The secret gate is pattern-based: a credential shape the pattern set does not know reaches a PR — but every PR still needs the repository owner's approval of its exact head, and the session never had credentials or network to begin with.
- The session canary's must-fail probes depend on the model attempting each step; a model that silently skips a step is caught only because the report must list every step and the must-succeed probes (writes inside the workspace, git status) prove it ran. A model that claims an attempt it did not make would make that probe vacuous; the runner-path canary (deterministic) covers the same OS mechanism.
- Writes to `/tmp` from a confined Claude session are prevented by pointing `CLAUDE_CODE_TMPDIR` at the attempt temp dir (live-verified), not by an explicit deny — an explicit deny breaks Claude Code's own shell bookkeeping. The canary's system-temp probe checks it on every attempt.
- Approver independence after acceptance: once accepted, any other full-tool session that opens the approver's browser profile could approve. Accepted by name in the spec and in the rendered acceptance text; undetected.
- Merged elsewhere is detection only (Attention + verify blocked); people with merge rights can still merge.

## 3. Level-of-abstraction fit

The executor reuses the drain database, the triage owner fence, the triage audit log and plan/commit store, `SafeFsExecutor`/`SafeGitExecutor`, the existing `safe-merge` script, the remote-close route and the Initiative phases. The two core touches are narrow: `SessionManager` options that only apply when explicitly passed (ordinary spawns are byte-for-byte unchanged, pinned by a test), and a `SafeGitExecutor` carve-out admitting an enumerated verb set only inside `.worktrees/feedback-*-a<n>[-publish|-base]` (the agent's own checkout never qualifies, pinned by a test). Attempt clones are removed by moving them into the executor's trash under `.instar/state/` and deleting there, so `SourceTreeGuard` is never weakened.

## Framework generality

The change touches the launch abstraction (`claudeHeadlessExtraFlags` in `frameworkSessionLaunch.ts`, and `SessionManager.spawnSession`). The new option is a framework-scoped confinement ADAPTER: `claudeHeadlessExtraFlags` emits the confinement flags only for `claude-code` (it returns nothing for every other framework, pinned by a unit test), and `spawnSession` refuses a confined launch for any framework without an adapter (`confinement-unsupported-framework`), so a confined spawn can never silently run unconfined on Codex, Gemini, Pi or Grok. Ordinary spawns of every framework are byte-for-byte unchanged (`cwd`, `omitAuthEnv` and `confinement` apply only when passed). This is the spec's stated, accepted gap against Framework-Agnostic: at ship only Claude Code has an adapter that passes the canary; Codex's `workspace-write` sandbox limits writes and network but not reads, so `codex-cli` becomes eligible when an adapter wraps it in the sandbox runtime and passes the same canary — eligibility is decided by the canary, not by name. Triage (Phase 1) stays framework-agnostic.

## 4. Signal vs authority compliance

- [x] No — this change produces signals and deterministic invariants; no brittle check gains blocking authority over a judgment.

The gates only hold (they never discard or publish on their own). Publication of a secret-shaped change set and acceptance of approver dependence are operator authorities behind the dashboard PIN. Merging is the repository owner's GitHub approval of the exact head; the executor only carries it out.

## 4b. Judgment-point check

No new judgment point. The executor acts on Phase 1's `work` disposition; its own decisions are invariants over observable facts (see inventory).

## 5. Interactions

- Triage: the executor's status pauses the work-queue ceiling clock (and `dry-run` pauses it too); executor holds use the spec's hold reasons, have no review timer, and are not model decisions (no `triage_decisions` row, so the ignore-rate brake is unaffected). Grades: operator approval → right (medium); merged + verified → right (strong); two not-reproducible → wrong (weak); infrastructure failure → unknown (weak).
- Green-PR Auto-Merge: executor branches are `feedback/*` with the `hold` label, so the watcher never arms them; stop paths run `--disable-auto` because a label does not stop an armed merge.
- SessionManager: confined sessions count against `maxSessions`; the spawn limiter and quota brake gate starts.
- Test-runner semaphore: confined test runs may write its holders/lock/witness/ledger files only.
- Existing triage tests were updated where Phase 1 asserted "executor not built" (the integration plan route now answers 409 "no held change set").

## 6. External surfaces

- GitHub: branch pushes to `feedback/<slug>-a<n>`, PRs opened with the `hold` label, label removal and `safe-merge --auto --match-head-commit` only after the approver's approval of that head, `--disable-auto` on every stop path. All gated by dev-gate + `dryRun:false` + availability.
- Claude Code sessions (confined build/canary) and trusted sessions (spec convergence, live proof — no MCP servers).
- npm registry: the dependency cache install (base-SHA manifests only, `--ignore-scripts`); the native rebuild only when no same-version, same-ABI binary can be copied, inside the sandbox runtime with a five-host allowlist.
- Routes: `GET /feedback-factory/execute/status`, `POST /feedback-factory/execute/tick|stop|release` (Bearer; stop/release are conversational operator levers), executor actions on the existing triage plan/commit (PIN to commit).
- Operator: lines in the existing daily action list (PRs awaiting approval, the approver question, held change sets, parked items) — each once.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the executor card states the situation in one sentence and shows only the action that is needed (accept approver dependence, or review-and-publish a held change set).
2. **Zero raw internals as primary content?** Yes: reasons are rendered as plain sentences; file names appear only where the operator must judge them (secret-shaped files), via `textContent`.
3. **Destructive actions de-emphasized?** There is no destructive action; both actions are plan-then-PIN with the server's exact wording.
4. **Plain language + phone width?** Reuses the existing card/button classes of the triage section.

## 7. Multi-machine posture

**proxied-on-read, owner-only writes.** The execution table lives in the owner-fenced drain database. Ticks, stop and release answer 409 naming the owner elsewhere; the status GET proxies to the owner with the stale fallback. Claims carry the owner epoch: a row claimed under an older epoch is stopped by the new owner (remote-close when the session ran on the previous owner), and an armed PR from an older epoch is disarmed and re-gated. Attempt clones, the dependency cache and the executor's scratch state are machine-local by construction (they belong to the machine running the attempt).

## 8. Rollback cost

`feedbackFactory.execute.enabled: false` stops new work and, on the next tick, disarms every armed PR; `dryRun: true` (the default) stops all side effects. Rows and PRs stay readable; nothing is deleted. A code revert leaves the `execution` table inert. The `SafeGitExecutor` carve-out and `SessionManager` options are inert unless passed.

## Deviations and conservative choices (spec ambiguities)

1. **`dryRun` defaults to true** even on the development agent (the spec lists `dryRun` as a field and says the executor goes live on Echo "once its preconditions hold"). Conservative: the operator flips it after the focused review round the spec requires before the Phase 2 PR merges.
2. **Order of gates**: diff gate → confined verification → secret gate (the spec lists the secret gate before the `fixed` checks). Running verification first means a held secret-shaped change set has already passed its checks, so the operator is never asked to publish something that fails; it adds no exposure because verification is confined.
3. **The "unit gate"** is the repository's lint gate plus the unit tests related to the changed sources (`vitest related`), each within the spec's 20 min limit; the full unit suite (~65 min) cannot fit that limit. The base canary runs lint plus a configured small smoke list once per stamp.
4. **Claude Code confinement** uses `--permission-mode dontAsk` with an explicit allowlist instead of `--dangerously-skip-permissions` plus denies: a live canary run showed that in bypass mode a write to a path created after spawn was allowed (only deny rules apply there). Also `--setting-sources local`, `--tools Bash,Read,Edit,Write,Glob,Grep,TodoWrite`, no MCP servers, and `CLAUDE_CODE_TMPDIR` set to the attempt temp dir.
5. **Session-path canary uses a decoy config** (same directory, same denial class) for the Bash/Read probes, so a failed sandbox can never put the real auth token in a transcript. The runner path reads the real config (output stays in memory, never logged).
6. **Dependency install** uses pnpm when it is on PATH and the base has `pnpm-lock.yaml`, otherwise `npm ci --ignore-scripts` (pnpm is not installed on the operated host). Both run base-SHA manifests only, no scripts.
7. **Release check** uses `ls-remote --tags` + `merge-base --is-ancestor` (read-tier verbs; no tag refs written) instead of `git tag --contains`, which `SafeGitExecutor` classifies as destructive.
8. **"Tagged vault entry"**: the vault has no tags; a vault entry is treated as tagged for the approver when an account record for that login names it (or a readable key name contains the login). Production passes `vaultNames: null` (the key names are not read here); the profile registry carries the references.
9a. **Verification location**: the head check, lint and related tests run in a fresh trusted clone with exactly the published bytes (not the session's workspace), after the base check in its own throwaway clone.
9. **Organization repositories**: an approver login "set only through the dashboard PIN" has no plan action yet (the spec's closed set has three); such repositories report `approver-unset` and the executor does not run. Not applicable to `JKHeadley/instar` (user-owned).
10. **Operator stop / release** are Bearer routes the agent calls on the operator's conversational instruction (the spec's "operator instruction in conversation"); stop only reduces automation, release only returns an item to the normal triage + human-review path.
11. **Push credentials**: global config is disabled for trusted git, so the push passes an explicit `credential.helper=!gh auth git-credential` (after resetting helpers). This is the one external helper trusted code runs, and only in the publish clone.
12. **Live-proof sessions** run without MCP servers (so they can never open a browser profile holding the approver's account); a harness that therefore cannot run leaves `verify` pending, counted in the status.

## Live verification of confinement (manual, this host)

Both application paths were run for real on the operated macOS host against a scratch agent home outside the system temp directory (sandbox-runtime 0.0.77, Claude Code 2.1.295, Haiku for the session canary), and re-run after the second-pass fixes. Final results: runner path 22/22 probes as expected (agent config, agent-home secret and a nonce directly under HOME refused from Bash and Node; the login keychain lookup refused; outbound fetch refused; writes outside the workspace, to `/tmp`, to `.git/config` and any publish-clone access refused; `ls ~/.instar/agents`, `~/.zsh_history` and `/tmp` unreadable; git status/diff, a SQLite open and a vitest run succeeded); session path 12/12 checks (Bash and Read/Write-tool probes incl. the HOME nonce refused, workspace writes and git status succeeded). An `env -i` start of the confined CLI with only the allowlisted variables authenticated and answered normally. The runs found four real defects that are now fixed and pinned by tests: the runtime's own socket path exceeding the unix limit under a long `TMPDIR`; vitest's results cache in the read-only `node_modules` (`--no-cache`); bypass-permission mode letting a newly created path be written (→ `dontAsk`); and a `/tmp` deny breaking Claude Code's shell bookkeeping (→ `CLAUDE_CODE_TMPDIR`). The first probe run also showed why the must-succeed probes matter: with the runtime broken every must-fail probe "passed" while the must-succeed probes correctly failed the canary.

## Conclusion

The executor runs attempt code only inside a verified sandbox, publishes only gated bytes from its own clone, and merges only the exact head the repository owner approved. It ships dev-gated and in dry-run; on Echo it additionally waits for the PIN-bound approver acceptance.

## Second-pass review (if required)

**Reviewers:** two independent reviewer subagents over the full diff — one security/adversarial, one correctness/integration.
**Independent read:** concur after fixes, with the open items below stated rather than implied away.

Fixed, each with a regression test:
- **Reads across the whole home directory** (security H1): the policy now read-denies all of `$HOME` and the shared temp directories and re-allows only the attempt's workspace, temp directory and dependency cache; the canary gained a nonce directly under HOME (Bash, Node and the Read tool) and a keychain lookup. Live-verified (above).
- **Bearer-only path to "independent"** (security H3): approver dependence is now sticky per login (removing the evidence never restores independence), an unreadable identity registry is dependence, and the PIN acceptance is bound to the exact set of reasons shown; a Bearer-only revoke route withdraws it.
- **Arm/disarm loop after an epoch change** (correctness H1): the merged check runs first; a stale armed PR is disarmed once and the row is adopted under the new epoch.
- **PIN-published PR orphaned** (correctness H2): publication restores the item to `work` instead of re-queuing it; re-triage stops a PR only on `hold`/`ignored`.
- **Spec merged without approval reaching the trusted session** (correctness H3): the merged-elsewhere check now precedes the spec hand-off.
- **Executor hold returning at once** (correctness H4): the hold re-binds the report count.
- **Verified bytes vs published bytes; session-controlled node_modules** (security M2): head check, lint and related tests now run in a fresh trusted clone holding exactly the published bytes, with node_modules linked by trusted code.
- **Survivor processes and link swaps while reading** (security M1): the finished workspace is first renamed to a path no sandbox policy can write, then read.
- **`.GIT`/ignorable-code-point names** (security M3): case-folded check in the walk and in apply; `core.protectHFS/NTFS` set.
- **Restart during verification** (correctness M1), **same-machine epoch change** (M2), **operator levers racing a tick** (M3, single-flight), **failed disarm recorded as disarmed** (M4, stays armed + retried), **acceptance breadth/withdrawal** (M5), **items stuck in work** (M6, ceiling uses whether the executor holds the item), **tooling list gaps and option-shaped file names** (security M6), **environment denylist** (security L1, `env -i` + allowlist), **branch collisions** (L3, hashed slug), **scratch retention** (correctness L1), **release lookups every tick** (hourly), **status 503 on a non-owner** (proxied).

Open items (named residual risks; none is reachable while `dryRun` is true, the default):
1. ~~**CI on executor branches (security H2).**~~ Closed in the focused review round (below, item A): branches are pushed to a fork only and PRs are cross-repository, so CI gets a read-only token and no repository secrets.
2. **The dashboard PIN is readable by the agent's trusted sessions** (security M4): `dashboardPin` sits in `.instar/config.json`, which the unconfined spec-convergence and live-proof sessions can read. This is a platform property shared with every PIN-gated flow (Phase 1 included); the spec already accepts the spec-convergence residual by name.
3. **GitHub's head pin while auto-merge is armed** (security M5): whether `expectedHeadOid` is enforced at merge time is GitHub behaviour the executor cannot verify; it disarms on the next tick when the head moves, and a merge at any other head is detected as merged-elsewhere.
4. **Base-failure evidence is test-controlled** (security L4): a session can write a test that fails at base and passes at head without exercising the reported problem; the human review of every PR is the safeguard, as the spec states.
5. **Old PRs are left open** after a stop, re-triage or merge-unavailable (correctness L2), and the spec-convergence hand-off is marked finished when its session ends without checking for its PR (L3).

## Evidence pointers

- Unit: `tests/unit/feedback-factory/execute-service.test.ts` (57, incl. the second-pass regressions), `execute-units.test.ts` (29), `execute-attempt-git.test.ts` (5, real git), `execute-wiring.test.ts` (5), `tests/unit/session-manager-confined-spawn.test.ts` (5), `tests/unit/PostUpdateMigrator-feedbackExecutor.test.ts` (2), dashboard and job-template updates; `tests/unit/self-action-convergence.test.ts` covers `feedback-execute`.
- Integration: `tests/integration/feedback-execute-routes.test.ts` (9); `tests/integration/feedback-triage-routes.test.ts` updated.
- E2E: `tests/e2e/feedback-execute-lifecycle.test.ts` (production path to a completed Initiative; 503 when dark).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (this change adds a self-triggered controller; no agent-authored-artifact defect is fixed).
- **`closure`:** `guard`
- **`guardEvidence`:** enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts`. How it is caught: `feedback-execute` attempts each item at most twice per failure episode and stops taking it after two episodes (durable per-item count), under a durable 6-starts/day cap and the concurrency/open-PR caps; registered in `SELF_ACTION_CONTROLLERS`, and the ratchet proves the attempt count is horizon-independent, including across restarts.

## Follow-up: full-suite ratchet fix (2026-10-09)

The full suite flagged `tests/unit/credential-env-token-gate.test.ts`: the `omitAuthEnv` env-token refusal in `SessionManager` used the exact expression that ratchet counts as a credential-source derivation (it pins exactly three, one per launch lane). The refusal now tests `.length > 0` on the same value; behaviour is unchanged.

## Focused review round (2026-10-09)

Verdict from the spec's focused review round: ship after fixes. Every finding below is fixed with a regression test. Commit identity `echo@sagemindai.io`; nothing pushed.

| # | Finding | Fix | Regression test |
|---|---------|-----|-----------------|
| A | CI on same-repository `feedback/*` branches runs with the canonical repository's token and secrets (`ci.yml` passes `SLACK_CONTRACT_BOT_TOKEN` to same-repo PRs) | New `feedbackFactory.execute.publishRepo` (`owner/name`). `publishFork()` (executePolicy) returns null when unset or equal to the canonical slug (case-insensitive). Availability reports `publish-fork-unset` (no new attempts; existing PRs keep being reconciled); `publish()` refuses (attempt `stopped`, nothing pushed) and `publishHeld()` refuses before touching state. The branch is pushed to `https://github.com/<fork>.git`; the PR is opened with `--head <forkOwner>:<branch>` against the canonical repo. Review gate, `headRefOid`, `safe-merge --match-head-commit` and `--disable-auto` all address the PR by number on the canonical repo, so they are unchanged for cross-repo PRs. The fork itself is created by the operator, not by this code. | `execute-service.test.ts` → "focused review round regressions" (A ×3); `feedback-execute-lifecycle.test.ts` asserts the fork push URL and the `owner:branch` head |
| 1 | Session-path canary judged read probes from the session's own report | `transcriptChecks()` reads Claude Code's own transcript (`<configHome>/projects/*/<uuid>.jsonl`, found by the fixed `--session-id` the confined spawn now passes; `Session.confinedConfigHome` records the home). It requires a Read tool call WITH a tool result for every out-of-workspace target and fails if the nonce appears anywhere in the transcript; an unreadable transcript fails closed. | `execute-units.test.ts` → "session read probes are judged from the transcript…"; `session-manager-confined-spawn.test.ts` (session id + config home); `execute-wiring.test.ts` (port passes the uuid) |
| 2 | Read/Edit/Write tools vs symlinks out of the workspace; Write through `node_modules/` | Explicit `Edit(...)` denies for the workspace `node_modules`, the attempt's deps cache and the whole `.worktrees/.feedback-deps`. New probes: a trusted-made workspace symlink to the nonce that the session must Read (judged by transcript), a Write through `node_modules/` (judged by the cache staying untouched), and a Bash write through `node_modules/` on the runner path. A model asked to BUILD such a link itself declines (seen live), so trusted code builds it. | `execute-units.test.ts` → link-probe, prompt and settings-deny tests |
| 3 | Hard links not rejected | `st.nlink > 1` is a special file in the walk and in `readNoFollow`. Runner canary probe `ln <nonce> <workspace>` must fail, and no hard link to the nonce may exist afterwards. (Live: the sandbox refuses `ln` of a read-denied file — "Operation not permitted".) | `execute-units.test.ts` → hard-link change-set test, link-probe test |
| 4 | Stop paths skipped while the executor refuses | `runStopPaths()` runs on every tick right after availability (only `not-canonical-owner` returns first): re-triage away from work, merge deadline, stale owner epoch, retry of a failed disarm, session past its lease. Rows a stop path acted on are not re-gated in the same tick. Authority-withdrawing refusals (`disabled`, `no-source-repo`, `auto-merge-disabled`, `approver-unset`, `approver-not-independent`) run `disarmAll()` over every open PR. With the executor not built (triage dark or failed), AgentServer runs `disarmExecutorPrsWithoutExecutor()` a minute after boot and hourly on the canonical owner (read-only on the database; a PR it cannot disarm raises a HIGH Attention line). | `execute-service.test.ts` (4 ×3); `execute-wiring.test.ts` (dark-triage sweep) |
| 5 | Ambiguous safe-merge exit could leave a PR armed and ignored | A null exit code (timeout/kill) records `merge-armed` + `disarmFailed` (`merge-outcome-unknown`), so the next tick disarms before anything else. Any failed disarm now parks the row `merge-armed` + `disarmFailed` whatever its state (`parkArmed`), including inside `mergeRefused`. `GhGateway.disableAuto` is idempotent (reads `autoMergeRequest`; unarmed/merged/closed → done), so every stop path (operator stop, re-triage, stale epoch, authority withdrawal) disables auto-merge on ANY open PR, armed or not. | `execute-service.test.ts` (5 ×3) |
| 6 | `spawnTrusted` sessions could activate the approver's browser profile | `POST /playwright-profiles/:id/activate` refuses (403, audited) when the target session was started by the feedback executor (`triggeredBy: 'feedback-executor'`, matched by tmux or logical name), before any write or refresh. Provision was already PIN-gated. The acceptance text no longer claims these sessions "can never open" the profile: a full-tool session that launches a browser on the profile's files itself is not prevented, and that residual is named in the PIN acceptance. | `playwright-profile-routes.test.ts` (403 for executor session, 200 for others) |
| 7 | Vault check never ran; only the active gh account was checked | `readVaultNames()` reads the vault's key names (cached by mtime/size); no vault → `[]`, an undecryptable vault → null → `vault-names-unreadable`. `GitHubGateway.authAccounts()` lists every github.com account from `gh auth status --json hosts`; any unreadable entry → null → `agent-github-accounts-unreadable`; a match → `agent-github-account`. | `execute-units.test.ts` (independence); `execute-wiring.test.ts` (vault names) |
| 8 | Lint/related tests could be faked by head test code rewriting the clone | Three separate fresh clones: `-base` (base check), `-head` (head check), `-gate` (lint then related tests). Each run has its own temp directory and its sandbox may write only its own clone and temp directory, so a process left behind by one run cannot reach a tree a later check reads. | `execute-service.test.ts` (8) |
| 9 | Ownership loss during preparation could leave an unrecorded confined session | The planned session name (`SessionManager.plannedTmuxSessionName`) is recorded under the fence BEFORE spawning; if recording the spawn fails the session is stopped at once (audited). A canary session interrupted by an error is stopped in `finally`. Under a stale epoch the catch path writes nothing; the new owner's stop paths end the row. | `execute-service.test.ts` (9) |

**Live re-check (this host, Claude Code + sandbox-runtime 0.0.77):** the full session canary prompt was run for real against a confined Claude Code session in the agent home: all 16 steps attempted; the three out-of-workspace Reads (including the one through the workspace symlink) were attempted and refused, the nonce never reached the transcript, the Write through `node_modules/` was denied and the dependency cache stayed untouched. Separately, `ln` of a read-denied file under the sandbox runtime is refused. (The probe workspace was not a real clone, so its `git status` check failed; in production the workspace is a real clone.)

**Remaining residuals (unchanged in kind):** the dashboard PIN is readable by trusted sessions (platform property); GitHub's enforcement of the pinned head while armed is unverified (disarm on the next tick, merged-elsewhere detection); base-failure evidence is test-controlled (human review is the safeguard); old PRs are left open after a stop; a full-tool trusted session could launch a browser on the approver's profile files directly (named in the acceptance). New operational dependency: fork PRs from a first-time contributor may need a maintainer to approve the CI run before checks start; a run that never starts ends at the 24 h merge deadline (disarmed, retried once, then parked).
