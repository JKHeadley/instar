---
title: "Jev correction shadow — log-only check on whether the correction sentinel misses corrections"
slug: "jev-correction-shadow"
author: "echo"
parent-principle: "Signal vs. Authority"
eli16-overview: "docs/specs/jev-correction-shadow.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-10-05T21:30:00Z"
approved-via: "Standing operator direction: only constitution changes need Justin (2026-09-28, recorded in memory only-constitution-changes-need-justin) and his standing 1.x approval for Jev work (topic 95267, 2026-09-21). This is a log-only, dev-gated Jev shadow that changes nothing the sentinel records; no constitution change. Revocable: flip the flag off or revert."
review-convergence: "2026-10-05T22:10:00Z"
review-iterations: 1
review-completed-at: "2026-10-05T22:10:00Z"
review-report: "docs/specs/reports/jev-correction-shadow-convergence.md"
single-run-completable: true
---

# Jev correction shadow — log-only check on whether the correction sentinel misses corrections

## Problem statement

The Correction & Preference Learning Sentinel (`src/monitoring/CorrectionCaptureLoop.ts`,
wired in `server.ts`) only distills a user message into a learning when a
Layer-0 keyword/weight detector (`HumanAsDetectorLog.classify`) marks it as a
`preference` or `frustration` signal. Every other message is logged
`no-signal` in `.instar/logs/correction-learning-audit.jsonl` and never looked
at again.

Verified on 2026-10-05: on the development agent the loop decided `no-signal`
for every message since 2026-09-29, although the operator plainly corrected the
agent on 1, 2 and 4 October. The keyword detector's recall is the problem.

A 14-day backfill (below) asked Jev (TypeSafe, pinned `jev-1.13.0`) about
every operator message: Jev flagged 90 of 347 as a correction or standing
preference; Layer 0 flagged 12. They agreed on 11. Before anything feeds the
sentinel, we need the same comparison running live, with no effect.

## Proposed design

### Input: the existing message seam

`TelegramAdapter.onMessageLogged` already fires for every logged message (the
capture loop chains onto it). The shadow chains onto it the same way, in its
own block in `server.ts`, independent of whether the correction sentinel is
enabled — so the measurement exists even where the sentinel is dark.

- An **agent** message (`fromUser: false`, provenance not `automation`) is
  remembered per topic (its last 8,192 characters — the scrub span, so the
  stored tail is still scrubbed before it is cut; at most 200 topics, least
  recently active dropped; memory only, never persisted or served). Automation
  notices are not what the user replies to, so they are not context.
- A **user** message (`fromUser: true`, non-empty) starts one detached check.

`observe()` is synchronous, never throws and never awaits. It defers the
whole check — vault read, daily-cap seed, scrub, Layer 0, the call — to a
later turn with `setImmediate`, so none of it runs in the message-logging
call stack.

### What is sent

`renderCorrectionState(user, prevAgent)`:

```
AGENT MESSAGE (context only):
<last 800 code points of the previous agent message, or "(none)">

USER MESSAGE (classify this one):
<first 1,500 code points of the user message>
```

Each raw field has a bounded slice (8,192 characters) scrubbed with
`scrubForStore` **before** it is cut, so a cut can never leave half a secret no
pattern matches (the jev-circles review's floor); a private-key marker
withholds the field. The rendered state is scrubbed again. A scrub failure
sends nothing (`scrub-error`).

### The question

One `choice` question, four options, asked in both option orders in the one
call (order flips moved ~6% of answers in the circles research):

- `correction` — the user says the agent got something wrong (a mistake, a
  misunderstanding, a false claim, unwanted work, something to undo or redo);
- `preference` — the user states a lasting preference or standing rule for how
  the agent should work from now on, without saying the last reply was wrong;
- `neither` — an ordinary request, question, answer, approval, thanks or
  information;
- `cannot_tell` — too short or unclear to tell.

Jev is never asked to count anything.

**Flag = forward-order P(correction) + P(preference) ≥ 0.5.** The sum, not the
top label: in the backfill Jev split one clear correction 0.49 / 0.48 between
the two labels, and a top-label rule missed it.

### Rows (content-free)

`logs/jev-correction-shadow.jsonl` (agent home, beside the other Jev logs), one
row per user message:

`{kind:'check', ts, topic, messageId, chars, hadContext, label,
confidence, pCorrection, pPreference, pNeither, pCannotTell, labelRev?,
jevFlag, layer0:{signal, kind, weight}, agree, ms}`

or `{kind:'skipped', ts, topic, reason}`, reason in a closed set:
`disabled-no-key` (once per key read), `daily-cap` (once per day, seeded from the log so a restart does not repeat it), `busy`,
`scrub-error`, `timeout`, `http-error`, `model-mismatch`, `no-answers`.

`layer0` is the sentinel's own verdict on the same text (`signal` = Layer 0
marked a learning signal, i.e. the loop would distill). `agree` =
`jevFlag === layer0.signal`. `messageId` and `topic` let a person join a row
back to the local message log for labelling. No message or context text, no
hash of it (an unsalted hash of a short reply such as "yes" would be
recoverable), no vendor error body.

### Read route

`GET /jev-correction/summary` (Bearer, like every route): checks, `jevFlags`,
`layer0Signals`, `both`, `jevOnly`, `layer0Only`, `agreement`, label counts,
`orderFlips`, skip reasons, `since`. 503 when not constructed. Reads at most the
last 5 MB of the log.

### Bounds and floors

- **Changes nothing the sentinel records.** The capture loop, its audit log
  and the ledger are untouched; no decision path reads the shadow log.
- **Delivers nothing.** No session, user or topic receives anything.
- **Secrets:** scrubbed before any cut and again before egress.
- **Spend:** a daily cap on attempted calls (default 500 ≈ $0.05/day at
  ~$0.0001 per call; the operator sends ~25 messages a day), seeded from the
  log so a restart does not reset it; at most 2 calls in flight (`busy`
  otherwise); fetch abort at `timeoutMs` (default 1500, max 10000). Every call
  is metered as feature `jev-correction-shadow` in feature metrics.
- **Stop:** `intelligence.jevCorrectionShadow.enabled` is read live on every
  message; explicit `false` stops it on the next message with no restart.
- **Never on the seam:** `observe()` is synchronous, cannot throw and defers the check; the prior
  `onMessageLogged` consumers run first and are unchanged.

### Config

No `ConfigDefaults` block: the defaults (model, timeout, cap) live in code, and
`enabled` is omitted, so `resolveDevAgentGate` decides — live on a development
agent, dark on the fleet. Registered in `DEV_GATED_FEATURES`. An operator may
set `intelligence.jevCorrectionShadow` = `{ enabled, model, timeoutMs,
maxChecksPerDay }`. Needs the vault `typesafe_api_key`; only the dev agent holds
one, so the fleet is inert twice over.

### Migration parity and awareness

- A `### Jev Correction Shadow` CLAUDE.md card, rendered by `generateClaudeMd`
  and appended by `migrateClaudeMd` (content-sniffed on the heading), and in the
  framework shadow markers so a Codex/Gemini agent can explain it.
- No config, hook or skill change, so nothing else to migrate.

### One-off backfill (research, not shipped)

`docs/research/jev/harness/idea5-correction-detector/backfill.mjs` (the
untracked research space, not in the npm package) imports the built module's
`renderCorrectionState`, `correctionQuestions`, `CORRECTION_MODEL` and
threshold, applies the same context rule to `.instar/telegram-messages.jsonl`,
and prints counts only.

Result (2026-10-05, last 14 days, 347 operator messages, 0 errors, p50 ~106 ms):

| | count |
|---|---|
| Jev flags (sum ≥ 0.5) | 90 (correction 20, preference 67, 3 split/neither-top) |
| Layer-0 learning signals | 12 |
| Both | 11 |
| Jev only | 79 |
| Layer-0 only | 1 (a pasted message from another agent; Jev read it as neither) |
| Agreement | 0.77 |

Per day, 1–5 October: Jev 3, 4, 4, 1, 1; Layer 0: 0 on every day. A
single-rater read by the author of the 90 flags judged roughly 75–78 genuine
corrections or standing rules; the weak ones sit at sums 0.50–0.65 (a bare
"yes" agreeing to a proposed rule, check-ins phrased as instructions).
Precision is the soak's question, not a claim made here.

## Decision points touched

None. This adds no block, allow, filter or delivery, and does not change what
the sentinel distills. Whether Jev should later feed the sentinel (as a second
trigger beside Layer 0) is decided after the soak, in its own spec.

## Multi-machine posture

Machine-local by design: each machine logs the inbound messages its own
Telegram adapter logs. The summary is per machine. The question being answered
is a rate, which per-machine logs answer; on a multi-machine pool the
serving machine logs the messages it serves.

## Framework generality

Framework-agnostic: it reads the Telegram message seam, not a transcript. Slack
is not covered, because the correction sentinel itself only listens to
Telegram; the comparison would be meaningless without a Layer-0 counterpart.

## Known gaps

- **Precision is unknown live.** The backfill is one rater's read. Rows carry
  `messageId` so a later labelling pass can score them.
- **Context is one message.** A correction of something said three messages
  back is judged with only the last agent message as context.
- **Messages relayed through the operator's account** (another agent's text
  pasted or posted via his login) are classified like his own; the backfill's
  one Layer-0-only row was such a message.

## Tests (three tiers)

- Unit (`tests/unit/jev-correction-shadow.test.ts`): rendering (labels, head/tail
  cuts in code points, `(none)`), scrub-before-cut (a token across the cut, a
  private key, secrets in both fields); the exact request (endpoint, bearer,
  model pin, both-order questions, four options including cannot_tell, no
  count); `observe()` returning before any of the check runs; stored agent
  context scrubbed before its cut (fails if the old 3,200-character pre-cut
  returns); content-free rows with the real Layer-0 classifier; a correction
  Layer 0 cannot see logged as a disagreement; the threshold on both sides and a
  split vote; recorded answer replay; context rules (automation and other
  topics ignored, bounded topic map); every skip reason; the daily cap across a
  restart and a new day; busy; live kill switch; metering; summary; the factory's
  dev gate on both sides and the live kill switch.
- Integration (`tests/integration/jev-correction-shadow-routes.test.ts`): a real
  `TelegramAdapter` logs an agent reply and an inbound correction; its
  `onMessageLogged` is chained as `server.ts` chains it; the prior consumer still
  sees both; one check; summary 200 through the real `createRoutes`; 503 when
  not constructed.
- E2E (`tests/e2e/jev-correction-shadow-lifecycle.test.ts`): the migrator adds
  the card once to a real agent home and writes no `enabled`; the factory reads
  `config.json` live; a real adapter and a real listening server; alive on a
  development agent, dark on the fleet, stopped by an explicit false; the
  `server.ts` wiring is asserted present.

## Rollback

Set `intelligence.jevCorrectionShadow.enabled: false` (live, no restart), or
revert the commit. Nothing to repair: the only state is the log file.
