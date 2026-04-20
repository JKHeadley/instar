---
title: Lifeline Message-Drop Robustness
status: draft
author: echo
date: 2026-04-19
scope: src/lifeline/
review-convergence: 2026-04-20
approved: true
---

# Lifeline Message-Drop Robustness

## Problem

The Telegram lifeline forwards every incoming message to the instar server via a single-shot `fetch` call. If that call fails for any reason — transient network error, 5xx, a version-skew rejection from the server — the lifeline gives up immediately and queues the message for later replay. The replay path itself retries the same single-shot forward on each recovery cycle and, after `MAX_REPLAY_FAILURES` (3) attempts, drops the message with only a `console.warn` log. The user is never told.

This is how two real user messages were lost on the Bob agent on 2026-04-19. Bob's lifeline had been running continuously on package version 0.28.20 while the server was on 0.28.61. The lifeline received the messages, tried to hand them off, was rejected three times by the version-mismatched server, and silently dropped them. From the user's perspective Bob simply never answered. There was no Telegram notification, no degradation event, no entry in any user-visible surface.

The incident surfaced three independent failure modes:

1. **In-flight forwarding has no retry.** A single transient failure bypasses the queue and heads straight for the replay-drop path.
2. **Replay-drop is silent.** When the replay counter hits its cap, the message is discarded with only a local log. No attention is ever raised with the user or the operator.
3. **Version-skew between lifeline and server is undetected.** The lifeline reports no version on handoff; the server accepts any version. A stale lifeline and a fresh server can disagree on payload shape and fail indefinitely.

This spec addresses (1) and (2). Failure mode (3) is a sibling problem staged separately because it requires a server-route change on both ends of the handoff; see "Out of scope" below.

## Relationship to existing dead-letter systems

The server-side codebase has two adjacent patterns for undelivered messages:

- `MessageRouter`/`MessageStore` (`src/messaging/`) — in-memory dead-letter queue for session-router state transitions (`expired→dead-lettered`, `failed→dead-lettered`).
- `state/failed-messages/` directory — server-side injection-failure records.

Neither is reusable here: the lifeline runs in its own process (a separate Node runtime managed by the supervisor), does not import `MessageRouter`, and must not acquire any in-memory handle to the server's message store. Stage A therefore writes a parallel, file-backed, lifeline-owned record at `<stateDir>/state/dropped-messages.json`. Stage B's version handshake will not collapse this separation — the lifeline remains a separate process even after handshake — but may later populate `MessageRouter.deadLetter()` via an internal endpoint once the version-skew signal is clean.

## Design principles

- **No message is dropped silently.** Every exhausted-replay drop must produce at least one of: a durable record, a `DegradationReporter` event, and a user-visible Telegram notice. The design produces all three.
- **Retry is mechanics, not judgment.** The in-flight retry is a fixed-policy helper. It does not decide whether a message "should" succeed — only whether the transport has exhausted its attempts. No brittle logic is granted blocking authority (per `docs/signal-vs-authority.md`).
- **Signals feed existing authorities.** Drops are reported through `DegradationReporter`, whose downstream pipeline already feeds `FeedbackManager` and the attention-topic alert. This spec does not introduce a parallel alerting path.
- **Additive state; zero schema change.** A new `state/dropped-messages.json` is ring-buffered and self-healing. No server routes, no handshake payload fields, no database changes.

## Scope

### In scope

- `TelegramLifeline.forwardToServer`: add a 3-attempt exponential retry (1s / 2s base) around the existing 10s-timeout `fetch`. Worst-case wallclock 3×10s + (1s + 2s) = ~33s, still inside the async polling loop.
- `TelegramLifeline.replayQueue` drop branch: on the existing `failures >= MAX_REPLAY_FAILURES` condition, before the existing `console.warn`, call a new helper that
  1. appends an atomic (tmp+rename) record to `<stateDir>/state/dropped-messages.json` (ring-buffered at 500 records, 200-char preview per record),
  2. emits a `DegradationReporter` event under feature `TelegramLifeline.forwardToServer`, and
  3. sends the original Telegram topic a plain-English notice asking the sender to resend. The notice quotes the original preview inside a Markdown code fence (with triple-backtick stripping) so `parse_mode: 'Markdown'` cannot render user-controlled links or formatting. The send is bounded by a 5 s timeout via `Promise.race` so a Telegram outage cannot compound the retry latency.

If the persistence in step (1) throws, a second `DegradationReporter` event is fired under the distinct feature `TelegramLifeline.dropRecordPersist` — its independent 1 h cooldown guarantees a loud operator-visible signal even when the primary feature is mid-cooldown (addressing the correlated-failure path where persist + sendToTopic + primary-cooldown would otherwise all swallow silently).
- Two new helper modules:
  - `src/lifeline/retryWithBackoff.ts` — policy-configurable retry primitive (`attempts`, `baseMs`, `onAttempt`).
  - `src/lifeline/droppedMessages.ts` — persistence + `notifyMessageDropped` orchestrator.
- Unit tests covering retry semantics, atomic append (including simulated crash mid-write), ring-buffer cap, and the full notify-dropped composition.

### Out of scope

- **Version handshake.** Lifeline reporting its `PKG_VERSION` on every forward, server validating it and returning `426 Upgrade Required` on mismatch, lifeline acting on that signal to restart itself. Tracked as Stage B of the same robustness workstream; requires a route change on `/internal/telegram-forward` plus a lifeline self-restart signal channel. Will ship under a separate spec.
- **Chaos tests.** Scripted node-swap, git-conflict, and sleep-induction scenarios that exercise the recovery paths under simulated failure. Tracked as Stage C.
- **Generalizing retry beyond this one call site.** `retryWithBackoff` is positioned in `src/lifeline/` and only consumed by `forwardToServer`. If a second consumer emerges it can be promoted to a shared utility without a behavior change.
- **Redesign of `MessageQueue`'s replay-failure counter.** The `MAX_REPLAY_FAILURES=3` threshold and its disk-backed counter are left as-is; this spec only changes what happens at the moment that counter's cap is hit.

## Acceptance criteria

1. A single transient forward failure (e.g., a 5xx response) no longer bounces the message straight to the queue; the in-flight retry gives it up to two more chances before falling back.
2. When `replayQueue` reaches the drop path, the following three side-effects all happen before the existing `console.warn` runs:
   - A record is appended to `state/dropped-messages.json` atomically.
   - `DegradationReporter.getInstance().report` is invoked with `feature = 'TelegramLifeline.forwardToServer'`.
   - `sendToTopic` is invoked with a plain-English "please resend" notice to the original topic.
3. A disk-write failure on step 2 (a) does not prevent steps 2 (b) and 2 (c). Persist errors additionally fire a distinct `TelegramLifeline.dropRecordPersist` DegradationReporter event (independent cooldown), and surface as a console log after the other signals have fired.
4. A `sendToTopic` failure on step 2 (c) does not prevent steps 2 (a) and 2 (b). The notice is best-effort.
5. The helpers are exercised by at least 15 unit tests, all passing. Full-suite regression: no new test failures caused by this change (pre-existing flakes and baseline-drift failures documented in the side-effects artifact).
6. The change is isolated to a worktree and does not touch any file outside `src/lifeline/`, the auto-generated `src/data/builtin-manifest.json`, `tests/unit/lifeline/`, and `upgrades/side-effects/`.

## Failure modes intentionally left unfixed by this spec

- **A stale lifeline against a fresh server.** Still possible. Stage B. Note: until Stage B ships, the Stage A retry amplifies version-skew latency (every rejected forward burns 3 attempts × 10 s + ~3 s backoff before entering the replay/drop path). This is an acknowledged Stage A ↔ Stage B coupling: the loudness-of-drop property still holds (the user now receives a "please resend" notice where previously they received nothing); only time-to-notice grows.
- **A crash after persistence succeeds but before `sendToTopic` fires.** The durable record and the `DegradationReporter` event are present; the per-sender notice is the one surface that can silently miss. Stage C chaos tests will exercise.
- **Simultaneous drops from concurrent lifeline processes.** Two lifelines would violate the exclusive lock-file the lifeline already acquires; out of scope here.

## Rollback

Pure code revert. `state/dropped-messages.json` is additive and ignored on downgrade. `DegradationReporter` simply stops receiving events under the new feature name. No migration, no downtime.

## Review convergence

This spec will run through `/spec-converge` — internal multi-angle review (security, scalability, adversarial, integration) plus external cross-model review (GPT, Gemini, Grok) — and only ship once convergence is reached and the author (user) applies the `approved: true` tag in this frontmatter.
