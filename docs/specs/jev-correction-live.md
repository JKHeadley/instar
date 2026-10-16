---
title: "Jev correction detector as a live input to the Correction & Preference Learning Sentinel"
slug: "jev-correction-live"
author: "echo"
parent-principle: "Signal vs. Authority"
parent-spec: "docs/specs/jev-correction-shadow.md"
eli16-overview: "docs/specs/jev-correction-live.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-10-16T05:15:00Z"
approved-via: "Build brief for this change (2026-10-15, desk relay): graduate the Jev correction shadow from log-only to live input for the correction sentinel, dev-gated with a kill switch, merge when green per standing approval. Stands on Justin's standing 1.x approval for Jev work (topic 95267, 2026-09-21) and his standing direction that only constitution changes need him (2026-09-28). No constitution change. Revocable: set feedSentinel false (live) or revert."
review-convergence: "2026-10-16T05:45:00Z"
review-iterations: 1
review-completed-at: "2026-10-16T05:45:00Z"
review-report: "upgrades/side-effects/jev-correction-live.md"
single-run-completable: true
---

# Jev correction detector as a live input to the correction sentinel

## Problem statement

The Correction & Preference Learning Sentinel (`src/monitoring/CorrectionCaptureLoop.ts`)
distills a user message into a learning only when the Layer-0 keyword detector
(`HumanAsDetectorLog.classify`) marks it. The Jev correction shadow
(`docs/specs/jev-correction-shadow.md`) has run live and log-only on the
development agent since 2026-10-05. Its log (`logs/jev-correction-shadow.jsonl`,
agent home) holds 40 rows where Jev flagged a correction or standing preference
and Layer 0 saw nothing. Joining those rows to the message log by `messageId`
(2026-10-15): about 33 are genuine corrections or standing rules from the
operator; 7 are notes this agent's own desk/observer sessions posted through the
operator's Telegram account, each opening "From Echo (…), not from Justin:".
The sentinel learned from none of the 33.

## Proposed design

### The feed

When the shadow's check completes for a user message and all of these hold:

- Jev flagged it (forward-order P(correction) + P(preference) ≥ 0.5, the
  shadow's existing line, `CORRECTION_THRESHOLD`);
- Layer 0 did **not** mark it (a Layer-0 signal is already distilled by the
  sentinel's own seam; feeding it again would double-count);
- `intelligence.jevCorrectionShadow.feedSentinel` resolves on;
- it is not excluded (below);

the shadow calls a sink, `setSentinelFeed(fn)`, with
`{ topicId, messageId, text, sessionName, pCorrection, pPreference }`. The sink
is installed by the sentinel's block in `server.ts`, which is constructed after
the shadow, through `getJevCorrectionShadow()`. With no sentinel (feature off,
or no shared intelligence) nothing is installed and the row records
`no-sentinel`.

### Exclusions

`feedExclusion(text, agentName)`, pure:

- **`agent-prefix`** — the text opens (after optional whitespace and markdown
  quote/emphasis marks) with `From <agentName>` as a whole word,
  case-insensitive. `agentName` is `config.projectName` (`echo` on the
  development agent). This is the desk-note convention; "From Echoes …" and a
  mention of the agent mid-sentence do not match. No agent name → never matches.
- **`signed`** — the text carries an agent-signature tag shape
  (`splitTag(text).hadTagShape`, or the `⟦asp1 ` marker anywhere). Any agent
  wrote it, verified or not; an agent's words are not the operator correcting us.

Exclusions only stop the feed. The shadow still asks Jev and logs the row, so
the measurement is unchanged.

### What the sentinel does with it

The sink runs the sentinel's existing `captureAndDistill` with the same deps as
a Layer-0 signal: the same CaptureRing, ledger, per-sentinel LlmQueue (its
daily cap), per-topic rate ceiling, quota load-shedding and durable backlog.
Two differences:

1. **Window.** The user turn was already pushed onto the ring by the sentinel's
   own seam callback when the message was logged; the Jev answer arrives about
   150 ms later, possibly after the agent replied. `captureAndDistill` gains an
   optional `window` input: when given, the ring is not pushed again.
   `windowEndingAt(ring, topicId, text)` returns the ring cut just after the
   last user turn with that exact text, or that one turn alone when the ring no
   longer holds it. The distill prompt therefore sees the conversation as it
   stood at the flagged message.
2. **Provenance weight.** The occurrence is recorded with
   `deterministicWeight = LEARNING_DETERMINISTIC_THRESHOLD` (3), the minimum
   weight a Layer-0 signal must reach. `CorrectionAnalyzer` counts only
   occurrences at or above that weight toward its recurrence gate; with weight
   0 a Jev-fed record could never promote, so the feed would do nothing.
   Rationale: the weight exists so an injected prompt cannot steer promotion
   through the distill LLM's own confidence. Jev's verdict is not the distill
   LLM's output, and the text it reads is the authenticated user's own message
   (agent-signed and agent-prefixed text excluded). Layer 0 reads the same text
   and is trivially satisfied by keywords, so an attacker able to write the
   operator's message already controls Layer 0. The gate itself is unchanged:
   four occurrences, two distinct days, two distinct sessions for a preference.

Audit rows written by the feed carry `trigger: 'jev'` in
`.instar/logs/correction-learning-audit.jsonl` (decision values unchanged).

### Rows and summary

A check row for a Jev-only flag gains `fed` when the feed is on:
`fed | excluded-agent-prefix | excluded-signed | no-topic | no-sentinel |
feed-error` (content-free). The summary (`GET /jev-correction/summary`) gains
`fed` (count) and `feedSkipped` (by reason). Absent when the feed is off, so
existing rows and readers are unaffected.

### Config and gating

`intelligence.jevCorrectionShadow.feedSentinel` (boolean, optional). Omitted ⇒
`resolveDevAgentGate`: live on a development agent, dark on the fleet. Explicit
`false` is the kill switch, read live on every check (the factory re-reads
`intelligence` per message). Registered in `DEV_GATED_FEATURES` as
`jevCorrectionFeedSentinel`. It is inert unless the shadow itself is on
(`enabled`), the vault holds `typesafe_api_key`, and
`monitoring.correctionLearning.enabled` constructed the sentinel. No
`ConfigDefaults` entry; nothing is written by the migrator.

### Migration parity and awareness

The CLAUDE.md card `### Jev Correction Shadow …` is rewritten to describe the
feed, both switches, and how to answer "why didn't you learn from my
correction?". `migrateClaudeMd` appends it when absent (unchanged) and, when
the installed card still carries the log-only sentence "It changes nothing the
sentinel records and sends nothing.", replaces that card (heading through the
end of its paragraph) once. Idempotent: the new card lacks that sentence. The
framework shadow marker (`### Jev Correction Shadow`) is unchanged.

## Decision points touched

One, and it is a signal into an existing authority-bounded pipeline: a Jev flag
now *triggers* a distill. It blocks, sends and delivers nothing. Every
consequential decision stays where it was: the distill LLM may return `noise`;
the recurrence gate decides promotion; a promoted preference is an advisory,
enveloped session-start hint that a real instruction or safety rule overrides.

## Multi-machine posture

Machine-local by design, same as the shadow and the sentinel: each machine
feeds its own sentinel from the messages its own Telegram adapter logs. The
ledger's existing multi-machine behaviour is unchanged.

## Known gaps

- **Precision is one rater's read** (~33 of 40). The distill step and the
  recurrence gate are the filters for the rest; the `fed` counts plus
  `/corrections` let a person audit what entered.
- **Relayed text without the prefix.** Another agent's words pasted by the
  operator without "From <agent>" or a signature are treated as the operator's.
- **Telegram only**, as the sentinel itself.

## Tests (three tiers)

- Unit (`tests/unit/jev-correction-shadow.test.ts`): feeds a Jev-only flag with
  text/topic/message/session and writes `fed` without text; no feed when the
  flag is omitted or false, and the kill switch read live; no feed for a
  Layer-0 signal or below the line; `agent-prefix` and `signed` exclusions with
  rows; `no-sentinel`, `no-topic`, `feed-error`; `feedExclusion` both sides of
  each boundary; factory dev gate on both sides and explicit values.
  (`tests/unit/CorrectionCaptureLoop.test.ts`): `windowEndingAt` cut and
  fallback; a supplied window is distilled once and the ring not pushed again;
  recorded weight.
- Integration (`tests/integration/jev-correction-shadow-routes.test.ts`): a real
  TelegramAdapter, the sentinel capture chain and the shadow chained as in
  `server.ts`, a real `CorrectionLedger`: a Jev-only preference lands as one
  record at weight 3 with a `trigger: 'jev'` audit row and an undoubled prompt;
  a "From <agent>" note does not; the summary reports `fed` and `feedSkipped`.
- E2E (`tests/e2e/jev-correction-shadow-lifecycle.test.ts`): the production
  factory reading `config.json`: fed on a development agent; dark on the fleet
  even with the shadow explicitly on; held by `feedSentinel: false`; dev-gated
  registration and the `server.ts` wiring asserted; existing agents' log-only
  card replaced once, surrounding sections kept, idempotent.

## Rollback

`intelligence.jevCorrectionShadow.feedSentinel: false` (live, no restart) stops
the feed and keeps the measurement. Records already in the ledger are ordinary
open correction records; they close or age out through the ledger's own
lifecycle like any other record. Or revert the commit.
