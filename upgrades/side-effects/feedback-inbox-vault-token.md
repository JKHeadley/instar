# Side-Effects Review — feedback inbox reads its Blob token from the vault; the drain job can really fail

**Version / slug:** `feedback-inbox-vault-token`
**Date:** `2026-09-29`
**Author:** `echo`
**Second-pass reviewer:** `required (scheduler completion path + a secret read at boot) — concurred`

## Summary of the change

Operator Justin approved switching on the operated feedback factory on the Mac Studio
(2026-09-29 19:38 PDT). Two defects had kept it silently dark for weeks:

1. `AgentServer` started the `InboxDrainer` only from `process.env.FEEDBACK_INBOX_BLOB_TOKEN`.
   The server runs in a tmux session whose environment was fixed when that tmux server started,
   so the lifeline's variable never reached it. The token was in the vault all along
   (`feedback_inbox_blob_token`, 62 chars, confirmed by name only).
2. The `feedback-factory-process` job recorded `success` on every run while
   `/feedback-factory/drain/status` said `unavailable: enabled-missing-operated-host-owner`.
   Its "fail this job run" instruction had no mechanism: `notifyJobComplete` records `failure`
   only for a failed/killed session.

Changes:

- `src/feedback-factory/inbox/resolveInboxBlobToken.ts` (new): env first, else vault
  (`SecretStore.get`, key `feedbackFactory.receiverPersistence.blobTokenVaultKey`, default
  `feedback_inbox_blob_token`), else none. Returns the value only; never logs it; never throws.
- `src/server/AgentServer.ts`: the drainer starts only on the drain owner
  (`resolveFeedbackDrainOwnerMachineId`, the operated drain's own resolver), then resolves the
  token and logs `Blob token source: env|vault`. On the owner with no token it reports a
  `FeedbackInbox.blobToken` degradation. A development agent whose drain posture is `unavailable`
  reports `FeedbackFactory.drainPosture`.
- `src/scheduler/jobDeclaredFailure.ts` (new) + `SessionManager` (both job spawn sites) +
  `JobScheduler.notifyJobComplete`: each job run gets `INSTAR_JOB_FAILURE_FILE` (named by its
  unique tmux session); if the job writes a reason there, the run is recorded `failure` with the
  sanitised reason.
- `src/scaffold/templates/jobs/instar/feedback-factory-process.md`: one posture table keyed on the
  body's `posture.state`; failure is written to the file.
- Awareness: `generateClaudeMd()`, `PostUpdateMigrator` (in-place sentence refresh for CLAUDE.md
  and the AGENTS.md/GEMINI.md shadows; declared-failure bullet), `CapabilityIndex`, the
  `/feedback-inbox/status` 503 message, `types.ts`.

### Considered and dropped (Occam)

- **Job `gate:` check** — a failing gate records a skip and schedules retries, not a failure.
- **Pane marker like `[JOB-FAILED]`** — the prompt is echoed onto the pane, so the marker in the
  body would trigger itself (the 2026-08-20 sentinel incident).
- **A new HTTP route for job failure** — more surface (auth, CapabilityIndex, three tiers) for the
  same effect as one file the scheduler already has the path for.
- **Per-slug file cleared at spawn** — round-1 review showed `processQueue` runs before
  `notifyJobComplete` in `server.ts`, so a queued rerun could clear the file first. A per-session
  name removes the ordering question entirely.
- **Job checks `/feedback-inbox/status` too** — on a non-owner machine that route 503s by design and
  the job has no exact owner test; the server-side owner-aware degradation covers it.

## Decision-point inventory

- Blob-token source (env > vault > none) — **add** — deterministic precedence.
- Drainer runs only on the drain owner — **add** — exact machine-id match via the existing resolver.
- Declared failure → run result `failure` — **add** — file present for this run's session.
- Job posture table — **modify** — prose for a tier-1 model; backed by the server signal below.
- Posture / no-token degradation reports — **add** — signals only.

---

## 1. Over-block

- The owner gate keeps the drainer dark on a machine that is not the configured
  `operatedHostMachineId`. A single-machine agent whose config was copied from another machine
  (so `operatedHostMachineId` names that other machine) now stays dark where the env var used to
  start it. That is the correct outcome for the shared cloud inbox; the warning names the reason.
- A job that writes the failure file by mistake gets a failed run. Only jobs whose body writes it
  are affected; today that is `feedback-factory-process`.
- The job fails on 401/403/unreachable on a development agent. On the Mac Studio `AUTH` falls back
  to the config token, which is stale on this machine, but `INSTAR_AUTH_TOKEN` is set in job
  sessions and is tried first. If it were not, the failure would be real and correctly reported.

## 2. Under-block

- A tier-1 model can still misread the job table. The server's `FeedbackFactory.drainPosture`
  degradation covers the posture case deterministically; a degraded run without a reason, or a
  broken invariant, still depends on the model.
- Runs that never reach `notifyJobComplete` (unknown job, boot-reconcile kill) leave their file;
  the result for those runs is recorded by the existing paths (or not at all), as before.
- If the vault is present but its key material is missing, the drainer stays dark; the
  degradation says `unreadable`. No automatic repair — correct for a secret store.

## 3. Level-of-abstraction fit

- Token resolution sits at the one construction site, beside the precedent (`ghToken.ts`,
  the parity-source `SecretStore.get` calls in the same file).
- Declared failure sits at the scheduler's single completion chokepoint (`notifyJobComplete`),
  so run history, the failure counter, the consecutive-failure alert and the Jev audit all follow
  from one `failed` flag.
- The posture signal uses the existing `DegradationReporter` surface rather than a new alert path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new blocking authority. The owner gate decides where a component runs on an exact id match
(the same resolver the operated drain already uses); it blocks no message or action. Declared
failure records the job's own statement about itself. Both degradations are signals.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. Every new decision is an exact match (machine id,
file present, posture string). The one judgment surface — the job body — keeps its existing
tier-1 model reader; the exact posture check is moved into code as a signal.

## 5. Interactions

- `alertOnConsecutiveFailures`: three declared failures in a row now alert the operator. This is
  intended. The alert is paced by the scheduler's existing alert state.
- Jev completion audit receives `result: 'failure'` for declared failures — correct.
- `session-manager-behavioral` / job spawn argv gains one `-e` pair for job spawns only.
- `processQueue`-before-`notifyJobComplete` ordering in `server.ts` is untouched and no longer
  matters for attribution.
- The existing env-var path is unchanged where it worked; env still wins.

## 6. External surfaces

- New log lines: `Blob token source: <env|vault>`, owner-gate warnings. No value is logged
  (asserted in the E2E test against every captured log line and the status body).
- `/health` `degradationSummary` may show `FeedbackInbox.blobToken` / `FeedbackFactory.drainPosture`.
- Job run history shows `Declared failure: <reason>`; the reason is scrubbed of token shapes and
  `Bearer` values before storage or alerting.
- The Mac Studio's cloud Blob inbox starts being drained (after restart) — the approved outcome.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (dashboard/approval/grant form) touched — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Drainer: single-owner by design.** The vault syncs the token to every machine; only the machine
  `resolveFeedbackDrainOwnerMachineId` names runs the drainer, so reports are never split between
  local stores. In a mesh with no configured owner, none drains (the cloud inbox holds reports).
- **Declared-failure file: machine-local by design** — written and read by the same machine within
  one run; run history is already per machine and merged by `/jobs?scope=pool`.
- **Degradations: machine-local by design** — each machine reports its own posture.
- No user-facing notices of its own (the scheduler's existing alert is one-voice per machine as
  before), no topic-bound state, no URLs.

## 7b. Constitutional Rules touched (Instar 2.0 `docs/01-the-rules.md`)

- **Rule 1 (Structure beats Willpower):** "fail this job run" now has a mechanism, and the exact
  posture check is in server code, not only in a prompt.
- **Rule 4 / Rule 86 (exact-match structure, signal vs authority):** every new code decision is an
  exact test; the degradations only signal.
- **Rule 26 (verify the state, not its symbol):** the failure file is bound to the run by its
  unique session name, not inferred from a timestamp (the conformance gate's round-1 flag).
- **Rule 100 (a secret is stored before it is spent):** the drainer now consumes the token from the
  vault where it was stored, instead of requiring an env copy; the value is never logged.
- **Rules 32 / 113 (multi-machine posture):** §7 above; the owner gate closes the scatter risk the
  vault sync would otherwise open.
- **Rule 74 (side-effects review):** this document.
- **Rule 111 (the layer below):** checked the resolver, the tmux spawn env, `SecretStore` read
  semantics, the queue/complete ordering and the scheduler's failure accounting.
- **Rule 116 (simplest robust route):** simplestRobustRoute — the required outcomes are "the
  drainer gets the token it already has" and "a job run that finds a broken pipeline is recorded
  failed". The simplest robust route is a read-site vault fallback (existing store, existing
  precedent) plus one file the scheduler names per run and reads at its existing completion
  chokepoint. Added machinery (owner gate, two degradations) each prevents a named failure: report
  scatter across machines once the token syncs; a dark drain or drainer that no model notices.
- **Safety floors:** secrets (never logged/returned/persisted anew; reasons scrubbed), durable
  intake (unchanged — the cloud inbox holds reports), spend/stop/duplicate sends untouched.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state beyond small per-run text files
under `.instar/state/job-declared-failures/` (harmless if left). The CLAUDE.md sentence refresh is
text only. Setting the env var still overrides the vault if the operator wants to pin the source.

## Conclusion

Converged over two spec review rounds (six material findings in round 1, one in round 2, all
resolved in the design and covered by tests) plus the standards-conformance gate's one flag
(timestamp attribution → per-session file). Clear to ship once the full suites are green.

---

## Second-pass review (if required)

**Reviewer:** independent Claude (Opus) subagent, read-only, over the full diff
**Independent read of the artifact: concur**

Concur: the code matches the spec and this artifact; no correctness bug or token-leak path found
(119 tests across the six touched suites passed in its run). Two non-blocking gaps it named were
closed before commit: the declared-failure bullet is now mirrored into AGENTS.md/GEMINI.md
(fragment loop in `migrateFrameworkShadowCapabilities`, tested idempotent), and the rerouted
interactive job spawn has its own `INSTAR_JOB_FAILURE_FILE` test
(`tests/unit/session-spawn-gh-token.test.ts`).

---

## Evidence pointers

- `tests/unit/feedback-inbox-blob-token.test.ts` — precedence, trimming, blank/non-string, corrupt vault.
- `tests/unit/job-declared-failure.test.ts` — path, read-once, cross-run isolation, sanitising,
  template + migration (CLAUDE.md and AGENTS.md shadow), idempotency.
- `tests/unit/JobScheduler.test.ts` — declared failure → `failure`, no file → `success`,
  killed + file → timeout with reason.
- `tests/unit/session-manager-behavioral.test.ts` — `INSTAR_JOB_FAILURE_FILE` on job spawns only.
- `tests/integration/feedback-factory-process-job-body.test.ts` — old body replaced on update,
  operator `enabled:false` kept, table rows present.
- `tests/e2e/feedback-inbox-lifecycle.test.ts` — real `AgentServer`: vault-only boot is alive and
  the Blob API sees the vault token; no token → 503 + degradation; not the owner → 503 and no
  token degradation; dev agent with drain `unavailable` → posture degradation.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `instrument-semantic-darkness`: the drain job ran every 30 minutes and
  emitted output, but the scheduler's contract (success unless the session failed/was killed)
  structurally prevented its verdict from changing when the drain was unavailable.
- **`closure`** — `guard`.
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/unit/JobScheduler.test.ts
  ("a declared-failure file records the run as failure with the reason") +
  tests/integration/feedback-factory-process-job-body.test.ts, howCaught: the job body must write
  $INSTAR_JOB_FAILURE_FILE for every failing posture row and the scheduler turns that file into a
  recorded failure; a body that only says "fail" in prose fails the integration test }`.

**Self-action declaration (trace host):** `{ defectClass: unbounded-self-action, closure: n/a,
reason: "no self-triggered loop added — one env var on the existing job spawn and a failure record
at the existing completion chokepoint; the only resulting notify is the existing, paced
consecutive-failure alert" }`. The `instrument-semantic-darkness` entry above is the defect this
change fixes; the self-action entry is the negative declaration the gate requires because the
diff touches spawn/notify paths.

