# The feedback inbox reads its Blob token from the vault, and a job can record its own failure

## What Changed

The operated feedback factory on the Mac Studio stayed dark for weeks for two reasons.

- **The drainer never got its token.** `AgentServer` started the feedback-inbox drainer only
  when the `FEEDBACK_INBOX_BLOB_TOKEN` environment variable was set. The server runs inside a
  tmux session whose environment was fixed when that tmux server started, so a variable set for
  the lifeline never reached it. The token was already in the agent's encrypted vault as
  `feedback_inbox_blob_token`. The server now falls back to that vault key when the variable is
  unset (the variable still wins when set; the key name is configurable as
  `feedbackFactory.receiverPersistence.blobTokenVaultKey`). It logs only which source supplied
  the token, never the value.
- **Only the drain owner drains.** The vault is copied to every machine of an agent, so the
  drainer now starts only on the machine that owns the drain (`feedbackFactory.operatedHostMachineId`,
  resolved exactly as the operated drain resolves it). Other machines stay dark and say why, so
  reports are never split between machines' local stores.
- **The drain job reported success while the drain was unavailable.** A prompt job had no way to
  record a failure: the scheduler recorded `failure` only when the session died or was killed.
  Each job run now gets `INSTAR_JOB_FAILURE_FILE`, a path unique to that run. A job that writes a
  reason there is recorded as failed with that reason (run history, failure count, and the
  existing consecutive-failure alert). Reasons are cleaned of anything that looks like a token.
- **The drain job uses it.** `feedback-factory-process` now rules on the status route's
  `posture.state`: `live` ticks, `dark` exits quietly, `unavailable` fails the run with the reason;
  an unreadable status fails the run on a development agent.
- **The server says so itself.** A development agent whose drain posture is `unavailable` reports
  a `FeedbackFactory.drainPosture` degradation, and the drain owner with no token anywhere reports
  `FeedbackInbox.blobToken`. Both show in `/health`.
- The CLAUDE.md template, existing agents' CLAUDE.md, and the AGENTS.md/GEMINI.md copies are
  updated to say where the token comes from and how a job declares failure. Existing agents get
  the new job body through the normal built-in job refresh.

## Evidence

- `tests/e2e/feedback-inbox-lifecycle.test.ts` boots the real `AgentServer` with the token only in
  the vault: `/feedback-inbox/status` is 200, the fake Blob server receives exactly the vault
  token, a report lands in the store, and no log line or response contains the token. With no
  token it is 503 with a degradation; on a machine that is not the owner it is 503 with no token
  degradation; a development agent with the drain unavailable records the posture degradation.
- `tests/unit/JobScheduler.test.ts`: a declared-failure file makes the run `failure` with the
  reason; no file keeps `success`; a killed run stays a timeout and carries the reason.
- `tests/integration/feedback-factory-process-job-body.test.ts`: an agent holding the old job body
  gets the new one on update and keeps its own `enabled` setting.
- `tests/unit/job-declared-failure.test.ts` and `tests/unit/feedback-inbox-blob-token.test.ts`
  cover the helpers and the awareness migration.

## What to Tell Your User

If you run the feedback-factory receiving end, I can now pick up its Blob token from my own
vault, so there is nothing extra to set up when I restart. And if one of my scheduled checks
finds something broken, it now shows up as a failed run instead of a quiet "success".

## Summary of New Capabilities

- The feedback-inbox drainer reads its Blob token from the vault when the environment variable
  is unset, and runs only on the drain owner.
- Scheduled jobs can record their own run as failed by writing a reason to
  `$INSTAR_JOB_FAILURE_FILE`.
