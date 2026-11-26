---
title: "Feedback inbox reads its Blob token from the vault; the drain job can really fail"
slug: "feedback-inbox-vault-token"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "feedback-inbox-vault-token.eli16.md"
parent-spec: "docs/specs/feedback-factory-migration.md (Q2b receiving end); docs/specs/feedback-factory-operating-drain.md (the cadenced drain job)"
review-convergence: "2026-09-30T03:00:04.055Z"
review-iterations: 3
review-completed-at: "2026-09-30T03:00:04.055Z"
review-report: "docs/specs/reports/feedback-inbox-vault-token-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "Codex reserved for Astra reviews by standing operator direction (2026-09-27); not launched"
approved: true
approved-by: "operator — Justin, 2026-09-29 19:38 PDT: approved switching on the operated feedback factory on the Mac Studio (\"Yes, please proceed\"); this spec is the fix that switch-on requires. Exercised by Echo under the standing merge-authority pre-approval for reviewed, gated code (2026-09-22)."
---

# Feedback inbox reads its Blob token from the vault; the drain job can really fail

## Problem statement

Two defects kept the operated feedback factory on the Mac Studio silently dark for weeks.

1. **The Blob token never reached the server.** `AgentServer` starts the `InboxDrainer` only
   when `process.env[FEEDBACK_INBOX_BLOB_TOKEN]` is set. The server is spawned by the lifeline's
   `ServerSupervisor` through `tmux new-session -e GIT_TERMINAL_PROMPT=0 ...`. A new tmux session
   takes its environment from the tmux server's global environment, which was fixed when that tmux
   server first started — usually by some other process long before the lifeline. So a variable
   set in the lifeline's (launchd) environment does not reliably reach the server, and on the Mac
   Studio it never did. The token has been stored in the agent's
   encrypted vault as `feedback_inbox_blob_token` all along. Every boot logged
   `receiverPersistence enabled but env FEEDBACK_INBOX_BLOB_TOKEN is unset — drainer stays dark`.

2. **The drain job reported success while the drain was unavailable.** `GET
   /feedback-factory/drain/status` returned 200 with `posture: { state: 'unavailable', reason:
   'enabled-missing-operated-host-owner' }` for weeks, and every `feedback-factory-process` run was
   recorded `success`. The job body only treated a 503 as degradation, and even then its
   instruction "fail this job run" had no mechanism behind it: `JobScheduler.notifyJobComplete`
   records `failure` only when the session status is `failed` or `killed`. A prompt job that ends
   normally is always recorded `success`, whatever it found.

## Proposed design

### A. Vault fallback for the Blob token

New pure helper `src/feedback-factory/inbox/resolveInboxBlobToken.ts`:

```ts
resolveInboxBlobToken({ env, envName, stateDir, vaultKey, forceFileKey? })
  → { token: string | null; source: 'env' | 'vault' | 'none'; vaultError?: true }
```

- Env first: a non-empty (trimmed) `env[envName]` wins, `source: 'env'`. The vault is not read.
- Otherwise the vault: `new SecretStore({ stateDir, forceFileKey }).get(vaultKey)`; a non-empty
  string (trimmed) → `source: 'vault'`. This is the same store and read path
  `.instar/scripts/secret-get.mjs` and `ghToken.ts` use.
- Otherwise `source: 'none'`. A vault read that throws (absent key material, undecryptable)
  returns `source: 'none', vaultError: true`; the helper never throws.
- The value is never logged, echoed or persisted. The helper returns it to the caller only.

**Only the operated host drains.** The vault syncs across the agent's machines (`SecretSync`),
and config can too, so a vault-resolvable token would let every machine with
`receiverPersistence.enabled` start a drainer. The drainer deletes each blob after its local
commit, so reports would scatter across machines' local stores. Before resolving the token,
`AgentServer` computes the drain owner with the existing
`resolveFeedbackDrainOwnerMachineId(feedbackFactory.operatedHostMachineId, selfMachineId,
multiMachineMode)` (the exact inputs the operated drain uses: `selfMachineId = meshSelfId ??
projectName`, `multiMachineMode = coordinator.enabled === true`). The drainer starts only when the
owner equals this machine; otherwise it stays dark with a warning naming the reason (`not the
operated host` / `owner unresolved`). This applies to both token sources. A single-machine install
with no owner configured resolves to itself, so today's single-machine behaviour is unchanged.

Config: `feedbackFactory.receiverPersistence.blobTokenVaultKey?: string`, default
`feedback_inbox_blob_token`. No ConfigDefaults entry (the default lives at the read site, like
`blobTokenEnv`), so no config migration is needed.

`AgentServer` replaces its env-only read with the helper, passing
`config.secrets?.forceFileKey`. It logs exactly one line naming the source:
`[feedback-inbox] Blob token source: env|vault` on success, or on `none` the existing dark warning
extended to name both places checked (and `vault unreadable` when `vaultError`). Fail-dark
behaviour when neither holds a token is unchanged: no drainer, `/feedback-inbox/status` 503s.

### B. A prompt job can declare its run failed

Today `notifyJobComplete` records `failure` only for a `failed`/`killed` session; a prompt job that
ends normally is always `success`. The job needs a way to say "this run failed, because ...".

- **Per-session file, passed by environment.** Both SessionManager spawn sites that already set
  `INSTAR_JOB_SLUG` (headless and rerouted-interactive) also set
  `INSTAR_JOB_FAILURE_FILE=<stateDir>/state/job-declared-failures/<tmuxSession>.txt`, and create
  that directory. tmux session names are unique per job run, so the file belongs to exactly one
  run by construction — no ordering or clearing race with the queue, no overlap question. The
  path comes from one shared helper `jobDeclaredFailurePath(stateDir, tmuxSession)`
  (`src/scheduler/jobDeclaredFailure.ts`), which both SessionManager and JobScheduler use.
- **Read at completion.** `notifyJobComplete(sessionId, tmuxSession)` calls
  `readJobDeclaredFailure(stateDir, tmuxSession)` first, before any await: it returns the reason
  (or null when absent) and deletes the file through `SafeFsExecutor`. The reason is scrubbed
  (`scrubSecrets`, plus `Bearer <x>` redaction), control characters and newlines collapsed to
  spaces, trimmed, and cut to 500 characters. An empty file gives `(no reason given)`; a file that
  exists but cannot be read gives `(unreadable)`, the safe direction.
- **Effect.** A non-killed session with a declared reason is recorded `failure` with
  `lastError: "Declared failure: <reason>"`. Everything downstream of `failed` follows unchanged:
  run history, consecutive-failure counter, the existing consecutive-failure alert, claim release,
  Jev audit result. A `killed` session keeps `timeout`, and a declared reason is appended to its
  `lastError` so it is not lost.
- **Why a file and not a pane marker:** the prompt is injected into the pane, so any marker the
  body names would appear in the capture and self-trigger (the 2026-08-20 sentinel incident
  recorded in `SessionManager`). A file exists only if the job wrote it.
- **Leftovers:** a run whose completion never reaches `notifyJobComplete` (unknown job, or a
  session killed by the boot reconcile) leaves its file behind. It is harmless — no later run can
  have the same name — and small; nothing sweeps it.
- **Trust boundary:** any process running as the agent could write another run's file. That is
  the same boundary as every other file under `.instar/state/`; documented, not defended.

### C. The drain job uses it

Step 1 of `src/scaffold/templates/jobs/instar/feedback-factory-process.md` rules on the status
route's body `posture.state`, whatever the HTTP code (the 503 body carries `posture` too,
`routes.ts` `/feedback-factory/drain/status`):

| Response | Development agent | Other agent |
|---|---|---|
| `posture.state` = `live` (200) | proceed to the tick | proceed to the tick |
| `posture.state` = `dark` | exit silently (explicit switch-off) | exit silently (fleet-dark) |
| `posture.state` = `unavailable` | **fail**: reason = posture.reason | **fail**: reason = posture.reason (the drain was enabled there) |
| no JSON / no `posture` / connection refused / 401 / 403 / other | **fail**: reason = HTTP code or `unreachable` | exit silently |

"Fail" means: write the reason to the declared-failure file, then finish the run normally:

```
[ -n "$INSTAR_JOB_FAILURE_FILE" ] && printf '%s' "<reason>" > "$INSTAR_JOB_FAILURE_FILE"
```

Step 3 uses the same line for a terminal `degraded` run without a reason and for a broken
simulation/live invariant, so every "never treat it as healthy" in the body has a mechanism.

### C2. The server raises the posture itself (Structure over Willpower)

The job is a model reading prose; the posture is an exact value the server already computed. So
the server also signals it deterministically: after the operated-drain init block, when
`developmentAgent === true` and the resolved posture state is `unavailable`, `AgentServer` calls
`DegradationReporter.getInstance().report({ feature: 'FeedbackFactory.drainPosture', ... })` with
the posture reason. This is a signal (no blocking authority), fires once per boot (so each restart
repeats it while the cause persists), and reaches the operator through the existing degradation
surface (`/health` `degradationSummary`). The job-level failure is the second, cadenced signal.

The drain posture does not cover the inbox drainer: the drain can be `live` while the drainer is
dark. So the drainer's own no-token outcome is reported the same way: when receiving is enabled,
this machine is the resolved owner, and no token resolved, `AgentServer` reports
`FeedbackInbox.blobToken` with the reason (`no Blob token ...` or `vault key ... unreadable`) —
key and variable names only, never a value. Non-owner machines report nothing (dark is correct
there). The job does not check `/feedback-inbox/status` itself: on a non-owner machine that route
503s by design, and the job has no exact owner test, so it would raise false failures.

### D. Awareness text

- `generateClaudeMd()` Feedback-Inbox section: "a Blob token env" → the env var
  `FEEDBACK_INBOX_BLOB_TOKEN`, else vault key `feedback_inbox_blob_token`.
- Job Scheduler capability section: one bullet — a job marks its run failed by writing a reason to
  `$INSTAR_JOB_FAILURE_FILE`, with the one-line command above.
- `CapabilityIndex` description and the `/feedback-inbox/status` 503 message name the vault.

### Migration parity

- Job body: `installBuiltinJobs` (called by `PostUpdateMigrator.migrateBuiltinJobs` on every
  update) always overwrites `.instar/jobs/instar/<slug>.md` from the shipped template, preserving
  the schedule manifest's `enabled`. Existing agents get the new body with no new migration. A
  test proves the refresh over an old body.
- CLAUDE.md: the Feedback-Inbox section is keyed on its own marker, so existing agents never get
  new text. A pure `refreshFeedbackInboxTokenAwareness(content)` replaces the old exact sentence
  ("+ a Blob token env; the route 503s when dark.") with the new one. It is applied in
  `migrateClaudeMd` and to the AGENTS.md/GEMINI.md shadows (the section is on the mirrored list),
  the same way `refreshOriginCapacityAwareness` is. When the old sentence has drifted it is a
  silent no-op. The declared-failure bullet is inserted after the built-in-job bullet under its
  own marker (`INSTAR_JOB_FAILURE_FILE`). Both are content-sniffed and run-twice safe.
- Config: none (read-site default).

## Decision points touched

- **Blob-token source (env > vault > none)** — `invariant`: deterministic precedence; env keeps today's behaviour byte-for-byte wherever it worked, and the vault is the agent's own custody store.
- **Drainer runs only on the drain owner** — `invariant`: exact match of two machine ids through the resolver the operated drain already uses.
- **Declared failure attributed to its run** — `invariant`: the file is named by the unique tmux session; only that run's completion reads it.
- **Killed session with a declared reason** — `invariant`: `timeout` keeps precedence; the reason is appended to `lastError`.
- **Server posture signal** — `invariant`: exact match on `developmentAgent === true` and posture state `unavailable`; a signal only.
- **Server no-token signal** — `invariant`: exact match on receiving enabled, owner equals self, and no token resolved; a signal only.
- **Job body: which responses fail the run** — `invariant`: the §C table is an exact mapping, carried out by a tier-1 model reading prose; §C2 carries the posture check in code as well, so the model is not the only reader.

## Multi-machine posture

- The drainer is **single-owner**: it runs only on the machine `resolveFeedbackDrainOwnerMachineId`
  names (the same owner as the operated drain); every other machine stays dark even though the
  synced vault holds the token. In multi-machine mode with no configured owner, no machine drains
  (absence is not permission to self-elect, the drain's existing rule). The cloud inbox holds
  reports durably meanwhile.
- The declared-failure file is **machine-local by design**: written and read on the machine that
  ran the job, within one run; job run history is already per machine and merged by `?scope=pool`.
- The posture degradation is **machine-local by design**: it reports this machine's own posture.

## Safety floors

- Secrets: the token value is never logged, returned over HTTP, written to disk or put in an
  error message; only the source name is logged. Tests assert the value is absent from every
  captured log line.
- Durable intake: unchanged. Reports stay in the cloud Blob inbox until drained.
- No duplicate sends / spend cap / stop: untouched.

## Rollback

Revert the release. Setting the env var still wins, so an operator can also pin the source. The
declared-failure check is inert unless a job writes the file.

## Rollout on the Mac Studio

The weeks-long `enabled-missing-operated-host-owner` posture is a separate cause from the token:
it means `feedbackFactory.operatedHostMachineId` was unset. The Mac Studio config now carries
`operatedHostMachineId: m_03b30f5b32c6ef3eb0afd3ca7054e252`, which is this machine's id
(`.instar/machine/identity.json`); it was written at 2026-09-29 19:39 PDT, after the running
server started, so the next restart applies it. After this release plus a restart the expected
state is: drain posture `live`, `/feedback-inbox/status` 200, log line `Blob token source: vault`.
If the owner were still missing, the job would fail every 30 minutes and the existing
three-in-a-row alert (itself paced by the scheduler's alert state) would reach the operator —
which is the intended loud outcome, not a regression.

## Maturation plan

- **test-agent-live:** The three test tiers in the test plan below, including the real `AgentServer` boot with the token only in a file-keyed vault and a fake Blob server that records which token it received.
- **dev-agent-live:** Echo on the Mac Studio after release and restart: drain posture `live`, `/feedback-inbox/status` 200, server.log `Blob token source: vault`, and the next `feedback-factory-process` runs recorded `success` with real ticks. Before the owner setting took effect the same job must record `failure` with the posture reason.
- **fleet:** Ships to the fleet in the same release. The vault fallback and owner gate are inert unless `receiverPersistence.enabled` is true (dark by default); the declared-failure file is inert unless a job writes it; the drain job stays dark on fleet agents exactly as today.
- **graduation criterion:** One restart on the Mac Studio with the drainer live from the vault and at least one fleet report drained into the canonical store; and one observed declared failure recorded in job run history (from a live run or a deliberate operator-visible check).
- **dark-window:** None for the fix itself. Receiving stays dark on every agent that has not enabled it, which is the existing, intended default rather than a maturation delay.

## Test plan

- **Unit** — `resolveInboxBlobToken`: env wins, vault fallback, blank env, custom key, none,
  non-string/blank vault value, undecryptable vault (flag, no throw), env short-circuits the
  vault. `jobDeclaredFailure`: path shape, absent → null, reason sanitised (newlines, control
  chars, `Bearer` and token shapes redacted, 500 cap), empty → `(no reason given)`, file deleted
  after read. `JobScheduler.notifyJobComplete`: declared file → `failure` + counter + lastError;
  no file → `success`; killed + file → `timeout` with the reason appended. SessionManager spawn:
  `INSTAR_JOB_FAILURE_FILE` set only for job spawns. Migration: `refreshFeedbackInboxTokenAwareness`
  old → new, idempotent, drifted text untouched; CLAUDE.md bullet inserted once.
- **Integration** — `installBuiltinJobs` over an agent holding the OLD job body refreshes it to
  the new body (Migration Parity) and preserves `enabled`; the shipped body names
  `INSTAR_JOB_FAILURE_FILE` and every row of the §C table.
- **E2E** — boot the real `AgentServer`: vault key only (no env) → `/feedback-inbox/status` 200,
  the fake Blob server receives exactly the vault token, the row lands, logs name `vault` and never
  contain the value; enabled with no token anywhere → 503 and a warning naming both places;
  `operatedHostMachineId` naming another machine → 503 and `not the operated host`, and no
  `FeedbackInbox.blobToken` degradation; owner is self with no token → a `FeedbackInbox.blobToken`
  degradation is recorded; development agent with drain posture `unavailable` → a
  `FeedbackFactory.drainPosture` degradation is recorded.

## Open questions

*(none)*
