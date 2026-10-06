---
title: "Jev review-flag shadow — log-only test of \"does this reply need the operator's review?\""
slug: "jev-review-flag-shadow"
author: "echo"
parent-principle: "Signal vs. Authority"
eli16-overview: "docs/specs/jev-review-flag-shadow.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-10-05T21:16:00Z"
approved-via: "Operator asked for the \"does this need your eyes?\" flag as a watch-only build in the Jev topic (95267) on 2026-10-05; standing operator rule: design docs and reviewed, gated code proceed without separate approval (only constitution changes need him). Log-only, dev-gated; revocable by flag or revert."
review-convergence: "2026-10-05T21:40:00Z"
review-iterations: 1
review-completed-at: "2026-10-05T21:40:00Z"
review-report: "docs/specs/reports/jev-review-flag-shadow-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
---

# Jev review-flag shadow — log-only test of "does this reply need the operator's review?"

## Problem statement

Justin finds some of our mistakes only by reading a reply and correcting it.
If a cheap check could say, after each reply, "this one is worth a human look",
we could later point his attention (or a stronger reviewer) at those replies
first. Nobody knows yet whether Jev (TypeSafe, `jev-1.13.0`) can tell.

This spec is a one-week measurement, built the same way as `jev-circles-shadow`:
ask Jev after every finished turn that sent a Telegram reply, write a
content-free row, deliver nothing. After a week, compare its flags against the
replies Justin actually corrected.

## What is judged: every reply the operator saw

The operator reads (and corrects) the messages relayed to Telegram, not
Claude Code's final terminal text, which is usually a different summary. So
the shadow judges each agent reply as recorded in the agent's own Telegram
history (`<stateDir>/telegram-messages.jsonl`, rows with `fromUser: false` and
`provenance: 'agent'`; automation sends are excluded). Each row carries the
Telegram `messageId`, which gives an exact join for scoring with no stored
text or hash.

## Proposed design

### Trigger: a server-side tail of the Telegram history

No hook and no settings change. A timer in the server (every 60 s, `unref`ed)
reads the last 512 KB of the history through the bounded `readJsonlTailLines`
(about 40 hours of this agent's traffic) and judges each agent reply that is:

- newer than the topic's watermark (the highest judged `messageId` for that
  topic; a bounded map of 500 topics, seeded at start from the log's
  `replyMessageId`s, so a restart judges nothing twice), and
- sent within the last 30 minutes (older replies are never backfilled; this
  also bounds the first tick after enabling or after a long outage).

This is framework-agnostic (Codex, Claude Code and any other session that
relays through the server land in the same history), has no race with the
reply being logged (a late-logged reply is picked up on the next tick), and
does not depend on which session a topic is mapped to.

A tick does not start while the previous one is still running. Within a tick
replies are judged oldest first, one call at a time; a reply not judged
because of the daily cap stays eligible (the watermark advances only past a
reply that was judged, failed at the vendor, or failed the scrub). The live config is read at
the start of every tick: disabled means the tick reads nothing.

### Selecting the request

For each reply, the request is the newest `fromUser: true` message in the
same topic sent before the reply and within 6 hours of it, from the same tail.
Optional (`hadRequest: false`).

### Inputs sent to Jev

`state` = `OPERATOR'S MESSAGE:\n<request>\n\nAGENT'S REPLY:\n<reply>` (the
request block is omitted when there is none). Each field is scrubbed with
`scrubForStore` **before** it is cut (the circles lesson: a cut can slice a
secret so no pattern matches what survives); a field showing a private-key
marker is withheld whole; the reply keeps its first 2,000 characters (the
answer leads; Telegram replies rarely exceed that), the request its first 600.
A cut is disclosed in band (`[reply cut at 2,000 characters]`) so Jev knows
text is missing, and in the row (`replyCut`, `requestCut`).
The assembled state is scrubbed again; any scrub error sends nothing
(`scrub-error`). Nothing else is sent: no tool output, no files, no transcript.

### The question and labels

Jev tags the one reply; it is never asked to count. One question, three
options, asked in both option orders in the same call (as circles does):

- `needs_review` — the reply claims something is done or fixed without showing
  evidence, asks the operator to decide or act, reports an irreversible or
  costly step, or does not answer what the operator asked.
- `fine` — a plain answer, acknowledgement or progress note that matches the
  request.
- `cannot_tell` — too little to judge.

**Would-flag = forward-order P(needs_review) ≥ 0.5.** The row keeps both
orders' probabilities so the threshold can be moved afterwards.

### Rows (content-free)

`<agent home>/logs/jev-review-flag-shadow.jsonl`, one row per check:

```
{kind:'check', ts, topicId, replyMessageId, requestMessageId?, session,
 replyChars, replyCut, requestCut, hadRequest, label, pNeedsReview, labelRev?,
 pNeedsReviewRev?, wouldFlag, model, ms}
```

or `{kind:'skipped', ts, topicId, replyMessageId, reason}` with reason in a
closed set: `disabled-no-key` (once per process), `daily-cap` (once per day),
`scrub-error`, `timeout`, `http-error`, `model-mismatch`,
`no-answers`. No reply text, request text, or vendor error body is ever
written. `session` is the history row's `sessionName` (may be null). `model`
is the model the vendor reported serving.

**Why content-free is still full provenance.** The judged input is fully
recoverable from the durable Telegram history by `replyMessageId` and
`requestMessageId` plus the fixed cuts above, and the model is pinned and
recorded per row. The log itself holds no message text, by design.

### Read route

`GET /jev-review-flag/summary` (Bearer, like every route): `enabled`, `since`,
checks, would-flags, label counts, skip reasons, per-topic
`{checks, wouldFlags, lastTs}`. 503 when the shadow is not constructed. Reads
at most the last 5 MB of the log. There is no write route.

## Ground truth and scoring (offline, after about one week)

The ground truth is the operator's next message in the same topic after a
judged reply (`replyMessageId`), within 2 hours, labelled once offline by Echo
with one fixed rubric: `correction` (says the reply was wrong, pushes back,
repeats the ask, or redirects), `approval`, `neutral`, or `ambiguous`
(excluded, and counted). Messages the desk sent through the operator's
account (they say they are from Echo or the desk) are not operator messages:
they are excluded, and counted. Every correction
ledger occurrence in the window counts as `correction`. Replies with no
operator message within 2 hours are `unreviewed` and are kept out of precision
and recall. (Checked 2026-10-05: the ledger alone holds about 2 corrections a
week, too few; the Telegram history holds ~108 operator messages a week.)

- **Flag rate:** would-flags ÷ checks. Above ~25% is too noisy to use.
- **Recall:** of replies followed by a `correction`, the share flagged.
- **Precision:** of flagged replies that got an operator reply, the share
  whose reply was a `correction`.
- **Lift:** correction rate among flagged ÷ among unflagged replied replies.
  Below ~2× it adds nothing.
- Report the forward/reverse disagreement rate, and both counts beside every
  rate (expected: tens of corrections, so the rates are rough).

The result is a short field note with a go / no-go for a next step (for
example a dashboard "worth a look" marker). This spec builds no next step.

## Bounds and floors

- **Delivers nothing.** No session, user, topic or gate reads the log.
- **Spend:** a daily cap on attempted calls (default 3,000), seeded from the
  log so a restart does not reset it; one call at a time; fetch
  timeout 1,500 ms (max 10,000). Metered as feature `jev-review-flag-shadow`.
- **Stop:** `intelligence.jevReviewFlagShadow.enabled` is read live at every
  tick; explicit `false` stops it within a minute, no restart.
- **Not on any request or hook path:** it is a background timer; no route,
  hook or send waits on it.
- **Server cost:** one bounded 512 KB tail read per minute; none when disabled.

## Signal vs. authority

Pure signal with no consumer: it observes, writes a content-free row, and
decides nothing. It has no blocking authority and no delivery path.

## Multi-machine posture

Machine-local by design. The Telegram history and the log are per machine;
each machine judges only the replies its own sessions sent, which is exactly
the set its history holds. Scoring reads each machine's log against the same
machine's history. Nothing replicates; nothing needs to.

## Config

```json
"intelligence": { "jevReviewFlagShadow": { "timeoutMs": 1500, "maxChecksPerDay": 3000 } }
```

`enabled` omitted: dev-gated (live on a development agent, dark on the fleet),
added to `DEV_GATED_FEATURES`. Needs the vault `typesafe_api_key`. Reaches
existing agents through `applyDefaults` (add-missing only). No hook or
settings change, so nothing else needs migrating. A
`### Jev Review-Flag Shadow` awareness card goes into `generateClaudeMd` and,
content-sniffed, into `migrateClaudeMd`.

## Cost estimate

About $0.0001 per call (the circles measurement; this request is about
2.6 KB, so budget $0.00015). Every agent reply is judged: roughly 200–400 a
day on this agent, so about $0.03–0.06 a day. The cap
bounds the worst case at $0.45 a day.

## Known gaps

- **Telegram only.** Slack replies are not in this history.
- **Acknowledgements are judged too** ("On it."); they should come back
  `fine` and are part of the flag-rate denominator. The scoring note reports
  the rate with and without replies under 80 characters.
- **Desk messages sent through the operator's account** can be picked as the
  request. They are rare in conversation topics; the scoring excludes them
  from ground truth (above).
- **Most replies are never read closely**, so "no correction" often means
  "not reviewed"; recall and precision use replied replies only.
- **Corrections without a prior reply** (Justin raising something new) cannot
  be matched and are dropped.
- The correction ledger has captured nothing since 2026-09-29; the Telegram
  history is the primary source, so this does not block the shadow.

## Review decisions (one round, 80/20)

Taken: tail the history from the server instead of extending the Stop hook
(removes the hook change, the reply-logging race, the session-name mismatch
and the Claude-only limit); judge every reply, not only a turn's last;
in-band and in-row cut disclosure; served model per row; `ambiguous` label and
desk-message exclusion in scoring. Not taken: a second Jev question for the
reason a reply needs review (the measurement is whether one label predicts
corrections; a reason can be added if it does); deterministic detector
features beside Jev (claim verification and action-claim already exist; this
measures Jev alone).

## Tests (three tiers)

- Unit: reply selection (agent provenance only, per-topic watermark, 30-minute
  window, seeded after restart, the cap leaves the reply eligible); request
  selection (operator only, before the reply, 6-hour window); scrub-before-cut
  and cut disclosure; exact request body (model pin, both orders, three
  labels); threshold both sides of 0.5; every skip reason; daily cap across
  restart and new day; live kill switch; metering; dev gate both sides.
- Integration: real `createRoutes`; summary 200 after a tick over a real
  history file; 503 when not constructed.
- E2E: the migrator writes the config block and the awareness card into a
  real agent home; the shadow is built with the server's factory reading
  config live; a dev agent judges a reply from a real history file and the
  summary is alive; a fleet agent makes no vendor call.

## Rollback

Set `intelligence.jevReviewFlagShadow.enabled: false` (live), or revert. The
only state is the log file.
