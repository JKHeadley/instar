---
title: "Terminal API rejection at session startup: detect it, name the cause, recover within bounds"
slug: "feedback-feedback-8e9629fe-c7d6-4d16-bf87-a09f598d9f66"
author: "echo"
status: "draft"
date: "2026-11-07"
initiative: "feedback-8e9629fe-c7d6-4d16-bf87-a09f598d9f66"
cluster: "cluster-session-silently-fails-every-turn-when-claude-code-binary-is"
severity: "critical"
component: "Session startup compatibility and failure reporting"
---

# Terminal API rejection at session startup

## 1. Problem

A session can be alive, sitting at its prompt, and failing every turn instantly
with an API 400 because the Claude Code binary cannot serve the model it was
launched with. The user's message appears delivered, nothing answers, and nothing
says why. Retrying cannot help: the same binary sends the same request to the same
model.

Required outcome: the user gets a visible, actionable error within about a minute,
recovery is bounded, and a model the operator chose is never silently replaced.

## 2. Evidence

### 2.1 The report

There is one report (received 2026-10-25). Treated as data, it says:

| Time | Event |
|---|---|
| 17:49:22 | Session spawned on the machine "Mama PC" for a forwarded message (topic 128732) |
| 17:49:28 | Message injected |
| after | Every turn failed instantly with API 400, attributed to a binary too old for the pinned model. The user was told nothing |
| 18:00 | A refresh after updating to Claude Code 2.1.310 fixed it |

The user was stranded for about 11 minutes, and only a manual update ended it. The
reporter asks that spawn check binary-vs-model compatibility, or detect the instant
400 loop, and then update or fall back automatically.

### 2.2 What the evidence does not contain

These gaps shape the design, so they are stated rather than assumed:

- **The exact 400 text.** Nothing in the report or the repo records it, so detection
  must not depend on a guessed phrase.
- **The old binary's version and the pinned model's id.**
- **Server logs and pane captures.** The causes in §3 come from reading the code. No
  incident logs were examined.
- **A reproduction.** This draft was written with no network or credentials, so the
  old-binary comparison has not been run. Phase 0 (§6) does this first.
- **The causal claim itself.** "Too old for the model" is the reporter's diagnosis.
  The update fixing it supports that but does not prove it.

## 3. Why the existing safety nets miss this

Each finding below was read from the current tree. Finding 1 is the leading
explanation for the silence, but it is **inferred, not observed**.

1. **The API-error check runs only on the first idle tick of an idle episode.**
   The check sits inside `if (!this.idlePromptSince.has(session.id))`
   (`src/core/SessionManager.ts:3781`, check at `:3804-3882`). The monitor ticks
   every 5s (`:3262`), and "idle" means a footer string is present anywhere in the
   capture (`:3723`). The likely sequence:
   - The fresh session reaches its prompt, the idle clock seeds, and the one-shot
     check sees a clean pane.
   - The message lands and fails in well under a tick.
   - No tick ever sees the session as active, so the clock is never cleared
     (`:3927-3938`) and the check never runs again.

   An instant failure is exactly the case this gate cannot see.

2. **If the check does fire, a 400 is treated as transient.** Any `API Error:` frame
   is a terminal error (`src/core/IdleErrorClassifier.ts:84`) and is handed to
   `apiErrorAtIdle`, which reports `errorClass: 'transient-api'`
   (`src/commands/server.ts:15041`). `RateLimitSentinel` then tells the user it is
   "likely a brief server-side blip" (`src/monitoring/RateLimitSentinel.ts:298`),
   retries up to 6 times over as long as 30 minutes, and finally blames the provider
   (`:471-473`). All of that is wrong for this failure.

3. **Recovery can report a false success.** `verify()` treats any JSONL growth as
   recovery (`RateLimitSentinel.ts:437-456`). The resume nudge is itself a new turn,
   so if Claude Code records it in the transcript, the sentinel would announce "Back
   online" while the session is still failing. *To confirm in Phase 0.*

4. **The wedge sentinel does not recognize this 400.** `ContextWedgeSentinel` matches
   only the thinking-block and Usage Policy signatures
   (`src/monitoring/ContextWedgeSentinel.ts:127-139`). Its fresh respawn would not
   help anyway, because the transcript is not the problem.

5. **Honest receipts have no matching kind.** `classifyStuckSignature` has no kind
   for a generic rejected request (`src/monitoring/StuckSignatureClassifier.ts:37-42`),
   so PresenceProxy falls through to its process-tree assessment, which is the
   "actively working" failure that classifier was built to prevent. Its tier-3 delay
   also defaults to 5 minutes (`src/monitoring/PresenceProxy.ts:784`).

6. **The sentinel escalation path is silent by default.** `SentinelNotifier.escalate`
   only logs unless `monitoring.sentinelTelegramEscalation` is true, and when enabled
   it posts to the system topic rather than the user's
   (`src/monitoring/SentinelNotifier.ts:126-139`, `src/commands/server.ts:15202`).
   Reusing it unchanged would reproduce this bug.

7. **Spawn has no Claude compatibility check.** `TopicProfileResolver` validates ids
   against a closed list that says nothing about binary version
   (`src/core/topicProfileValidation.ts:307`). The one binary-vs-model check is
   Codex-only (`src/core/TopicProfileResolver.ts:258-268`).

8. **The fallback respawn repeats the failure.** A topic-bound idle session is killed
   only after 240 minutes (`SessionManager.ts:448`). The `injectionDropped` handler
   (`src/commands/server.ts:12962`) may then respawn it with the same binary and
   model.

## 4. Goals and non-goals

**Goals**

- G1. Detect a terminal API rejection however fast the turn fails, including on a
  session's first turn.
- G2. Tell the affected user in their own topic, with the cause and a concrete next
  step, within about 60 seconds.
- G3. Stop retrying what cannot succeed. Every recovery action has a hard budget.
- G4. Respect model configuration: an operator pin is never changed or silently
  bypassed.
- G5. Resume on its own once the cause is fixed, with no manual refresh.

**Non-goals**

- Automatically updating the Claude Code binary (§5.6, Q1).
- Changing how thinking-block and Usage Policy wedges are handled.
- Non-Claude frameworks. Codex already has its own check, and other frameworks print
  different error frames.
- Fixing finding 6 for existing sentinels. It deserves its own item (§9).

## 5. Proposed design

### 5.1 Detection: a repeatable check, classified by status

**a. Evaluate on pane change, not only on first idle.** While a session is idle,
re-run `classifyIdleError` whenever the pane content hash changes. A hash gate keeps
the cost to one comparison per tick on quiet sessions. The existing per-episode
guards still stop repeat emits for an unchanged frame.

**b. Extend the classification.** `IdleErrorClassification` gains
`httpStatus?: number`, parsed from the Tier A frame (`API Error: 400 ...`). It remains
a signal with no blocking authority.

**c. Split the routing.**

| Frame | Owner |
|---|---|
| Thinking-block or Usage Policy signature | `ContextWedgeSentinel`, unchanged |
| 429, 5xx, timeout, connection failure, no parsed status | `RateLimitSentinel`, unchanged |
| 400 or 404 not matching the above | New `request-rejected` path (§5.2) |
| 401 or 403 | Unchanged here. Login-expired handling owns auth; confirm the boundary in review |

Unknown shapes stay on today's path, so a parsing miss cannot strand a session worse
than it is now.

### 5.2 Confirmation: a differential probe

Because the 400 text is unknown and may change, the design does not match on the
error's wording. It asks the binary directly.

Add a `request-rejected` wedge kind to `ContextWedgeSentinel`. That reuses its tick,
tail gate, confirm window, guard rows and `isRecoveryActive` zombie veto. Two changes
are required:

- This kind uses a 20-line tail and a capture of at least 45 rows. The default
  10-line tail in `classifyWedgeTail` can be pushed out by the input box and footer
  (see the sizing note at `IdleErrorClassifier.ts:36-42`).
- Recovery and notification are per-kind. This kind must not use the fresh-respawn
  `recoverFn` or `notifier.escalate`.

A rejection is **confirmed** when the frame is still the live tail after the confirm
window, and either the session has produced no assistant reply since launch, or two
consecutive turns have failed. The first condition matters because a stranded user
may send only one message, so requiring a second turn would stall detection.

Confirmation then runs **one** probe pair, using the session's own launch binary,
auth environment and config home, with a 60s timeout each:

| `-p` with session's `--model` | `-p` with no `--model` | Verdict |
|---|---|---|
| Fails with 400/404 | Succeeds | **`model-incompatible`**: this binary cannot serve this model |
| Fails | Fails | **`runtime-failure`**: not model-specific (account, binary or transcript-independent fault) |
| Succeeds | Succeeds or fails | **`session-specific`**: the model works here, so the fault is in this session's request |
| Timeout or probe error | any | **`unknown`**: notify honestly and do not act |

Cost is at most two tiny turns per episode, and only after a failure is confirmed.
Spawn latency is unaffected.

### 5.3 User notification

Delivery uses the topic-first, lifeline-fallback path in
`buildRateLimitRecoveryDeps.notifyFn` (`src/monitoring/sentinelWiring.ts:445`) through
`sendAutomationReply`. It does not depend on `sentinelTelegramEscalation`. The notice
is **on by default**: it is the core of this fix, and one fixed message per episode
carries little noise risk.

Each message is a fixed template. Only the version and model are substituted, both
from trusted launch state and never from pane text. Example for `model-incompatible`:

> I can't reply on this thread: Claude Code 2.1.xxx on this machine is being rejected
> for the model `<model>`, so every turn fails right away. This won't clear by
> retrying. To fix it, update Claude Code (`npm install -g
> @anthropic-ai/claude-code`). I'll restart this session on its own once the update
> lands. Your message is safe; you don't need to resend it.

The "safe" sentence appears only if §5.5 actually holds the message. Otherwise the
template asks the user to resend. The wording says the version "is being rejected"
rather than "is too old", because the probe proves the pairing fails, not why.

Add `StuckKind` `request-rejected` so PresenceProxy reports the truth instead of
"working". Marking the episode through `isStuckRecoveryActive` leaves the sentinel as
the single voice. Add a matching stall class to `src/data/stall-classes.ts`, ordered
after `policy-rejection-loop` so the more specific signatures win.

### 5.4 Bounded recovery ladder

Each rung runs at most once per `(session, cliVersion, model)`. All respawns also go
through the existing `SessionRefresh` guard (5 per 10 minutes). The error nudge and
`RateLimitSentinel` are suppressed while an episode is active.

| Step | Condition | Action | Touches model? |
|---|---|---|---|
| 1 | Configured binary is newer than the session's launch version | One `--resume` respawn on the newer binary | No |
| 2 | Verdict is `model-incompatible` and the model is **not** a `profile-pin` | Session-scoped fallback (§5.5) with a one-time notice | Session only |
| 3 | Verdict is `model-incompatible` and the model **is** a `profile-pin` | Stop and notify. Offer the update, or a one-tap "use the default for this session" | Only on user consent |
| 4 | Verdict is `session-specific` | One fresh respawn (existing fresh mode) | No |
| 5 | Verdict is `runtime-failure` or `unknown`, or any rung failed | Stop, notify, record | No |

After a terminal stop, the session is left alone and nothing further is retried until
the watch in §5.5 fires.

### 5.5 Compatibility ledger, fallback and resume

**Ledger.** A `model-incompatible` verdict records `(cliVersion, model, verdict, at)`
in `.instar/state/claude-model-compat.json`.

- It is **per machine and not synced**, because binaries differ between machines.
- It is keyed by exact version, so any version change invalidates an entry by
  construction, and entries also expire after 7 days.

**Pre-spawn check.** `TopicProfileResolver` gains a `claudeModelSupported` hook beside
the Codex branch, reusing the `onceNotice` pattern. The version comes from the value
`resolveLaunchBinary` already resolves (`SessionManager.ts:6769-6770`), so spawn needs
no new subprocess. A ledger hit means:

- **Non-pin model:** launch with no `--model`, using a new source label
  `older-claude-cli-fallback`, and send the notice. The chosen fallback is the account
  default that the probe just proved works.
- **Pin:** do not launch into a known failure. Notify as in step 3 and hold the
  message.

`injectionDropped` respawns check the same ledger, which closes finding 8. Headless
job launches check it too and fail the job with the named cause. Fallbacks are never
written to config or to the pin.

**Why learned rather than a static floor table.** The only version data in the repo
is "verified on" comments (`src/core/ModelTierEscalation.ts:194-204`, CLI 2.1.263 and
2.1.281). Those are not minimums, and treating them as floors would refuse working
combinations. That file already records how a stale allowlist silently masquerades as
a policy decision. A static `minCliVersion` can be added later for measured values
only.

**Automatic resume (G5).** While an episode is held, a once-a-minute cheap version
read of the configured binary (the `package-json` path in `ClaudeBinaryRetainer`, with
no subprocess) detects a change. On a change it does one respawn, redelivers the held
message and posts a short notice. This automates what the reporter did by hand at
18:00. The watch ends on success, session end, or after 24 hours with a final notice.

**Holding the message.** `pendingInjections` keeps only the first 200 characters
(`SessionManager.ts:8785`), so it cannot be the source for redelivery. See Q3.

### 5.6 Why no automatic binary update

The reporter asked for it, but this draft leaves it out of v1, for three reasons:

- The install is global and shared by every session on the host. The in-place
  replacement is the event behind the kernel leak `ClaudeBinaryRetainer` exists to
  contain (`src/core/ClaudeBinaryRetainer.ts:5-13`).
- It may need privileges the agent lacks, and a failure mid-update affects everything.
- A background update of a shipped tool triggered by a pane string is a large action
  to hang on a detector.

With §5.5, the operator's only step is running the update, and resume is automatic.
An opt-in can follow if Q1 says so.

### 5.7 Trust and safety

- Pane text is untrusted, and an agent can print `API Error: 400` on demand. The
  tail gate, the confirm window and the probe all limit that. The probe result, not
  the text, drives every action, and the worst outcome of a false positive is one
  notice.
- Model ids reach argv only from validated launch state, never from pane text.
- `matchedLine` stays in audit logs, clamped as today, and never reaches a user
  message.
- No new blocking authority is created. Detectors stay signals, and the recovery
  ladder is a bounded primitive like `SessionRefresh`.

## 6. Rollout

**Phase 0: reproduce and capture (blocks detection tuning).** Run an older binary with
the pinned model, inject a message, then compare against 2.1.310. Capture:

- the exact pane frame and the JSONL entries
- the monitor's `idle-error-classify` log lines
- whether the nudge grows the JSONL (finding 3)

If finding 1 turns out not to be the cause, revise §5.1a before building.

**Phase 1: signal and notice, on by default.** §5.1, §5.2, §5.3, plus the ledger write.

**Phase 2: recovery, dark first.** §5.4 and §5.5 under
`monitoring.contextWedgeSentinel.requestRejected.autoRecovery`, default off with
dry-run, with its own `guardManifest` row like the existing `autoRecovery` sub-guard.
It then follows the Graduated Feature Rollout track.

## 7. Test plan

Unit:

- `IdleErrorClassifier` parses `httpStatus`, and a quoted `API Error: 400` in prose
  stays a miss.
- Routing table in §5.1c, including that thinking-block and Usage Policy 400s keep
  their current owner and a 500 stays transient.
- **Regression for finding 1:** idle clock already seeded on a clean pane, the frame
  then appears with no active tick between, and the rejection is still reported.
- Confirmation on a first-turn failure with a single message.
- Every row of the probe table, including timeout giving `unknown` and taking no action.
- Ladder budgets: one action per rung per key, nothing further after a terminal stop.
- **Pin safety:** a `profile-pin` never yields `older-claude-cli-fallback` without consent.
- Ledger: a version change invalidates an entry, and entries expire.
- Notice templates contain no pane text. The "safe" sentence appears only when the
  message is actually held.

Integration:

- A rejected session gets one topic notice with `sentinelTelegramEscalation` off, and
  no "brief blip", "Back online" or provider-blame text.
- `injectionDropped` does not respawn into a ledger-known failure.
- PresenceProxy reports `request-rejected` rather than "working".

End to end (fake `claude` binary that returns a 400 for one model):

- Spawn, inject, notice within 60 seconds, swap the fake binary's version, automatic
  respawn, message redelivered and answered.
- Run on a real old binary once as part of Phase 0.

## 8. Open questions for the operator

- **Q1. Automatic update.** Should there be an opt-in `autoUpdateClaudeCli`, or a
  one-tap "update now" in the notice? Recommendation: skip for v1 and revisit on
  evidence.
- **Q2. Fallback for non-pinned models.** Is automatic session-scoped fallback right,
  or should all model changes need consent? Recommendation: automatic with a notice,
  matching the Codex precedent, and always consent for pins.
- **Q3. Source of the held message.** Should redelivery read from
  `InboundDeliveryStore`, or should a full-text hold be added? It must also not
  double-deliver a message the resumed transcript already contains. Recommendation:
  decide after Phase 0 shows what `--resume` retains.
- **Q4. Probe cost.** Two small turns per confirmed episode on the session's account.
  Is that acceptable when the account is near its limit? Recommendation: yes, but
  skip the probe and report `unknown` when quota state says the account is exhausted.

## 9. Related follow-ups, out of scope here

- Finding 6 applies to existing wedges too: with default config, a confirmed
  thinking-block or Usage Policy wedge escalates to logs only.
- Finding 3 applies to genuine transient errors as well. `verify()` should also
  require that the live tail is no longer an error frame.
- The first-idle gate (finding 1) may also hide fast-failing transient errors. §5.1a
  fixes this for all classes, so expect some additional `apiErrorAtIdle` traffic.
