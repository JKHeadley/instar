---
title: "Jev circles shadow — log-only measurement of the \"going in circles\" nudge"
slug: "jev-circles-shadow"
author: "echo"
parent-principle: "Signal vs. Authority"
eli16-overview: "docs/specs/jev-circles-shadow.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-09-30T19:00:00Z"
approved-via: "Operator approval 2026-09-30 in the Jev topic (95267) to explore and build the circles nudge; this build is the shadow-only, dev-gated step the research note recommends. Stands on his standing 1.x approval for Jev work (topic 95267, 2026-09-21). Revocable: flip the flag off or revert."
review-convergence: "2026-09-30T20:15:00Z"
review-iterations: 1
review-completed-at: "2026-09-30T20:15:00Z"
review-report: "docs/specs/reports/jev-circles-shadow-convergence.md"
single-run-completable: true
---

# Jev circles shadow — log-only measurement of the "going in circles" nudge

## Problem statement

Justin's standing rule: after about three failed rounds on the same system, stop
patching and do a structural review. Nothing today notices the fine-grained
version of that loop — an agent editing, testing, hitting the same failure, and
trying the same fix a third time.

The 2026-09-30 research (field note `2026-09-30-idea3-circles-nudge.md`, harness
`harness/idea3-circles/`) measured Jev (TypeSafe, `jev-1.13.0`) on 656 real
episodes from our own transcripts and builder logs. A five-label question over
a 15-action window caught 36/44 real "same fix, same failure, third try" loops
(recall 0.82) with 29/612 false alarms (4.7%), 1/95 on legitimate polling, and
held on held-out halves (0.81–0.82 recall at 4.2–5.3%). p50 117 ms, about
$0.0001 per check. The note's recommendation: a dark shadow that logs
would-nudge verdicts with no delivery, judged after a week on how often it would
fire and how often a person agrees.

This spec is that shadow. Operator approval: Justin, 2026-09-30, Jev topic 95267
("explore and build this").

## Proposed design

### Input: the session's own transcript, reached through the existing hook

The research windows were built from Claude Code transcripts: for each tool
call, the agent's short note, the action (command, edit, read), an ok/ERROR flag
and the last ~160 characters of the result.

The existing `hook-event-reporter.js` (PostToolUse) forwards only the tool
*name*. Worse, a verified live probe (Claude Code 2.1.286, 2026-09-30) showed a
failed tool call fires `PostToolUseFailure`, **not** `PostToolUse` — so no event
stream the hook sees contains failures, which are the loop's defining signal.

So no new hook is added. The existing reporter forwards one more field it
already receives on stdin: `transcript_path` (a path, never content). The
server reads the tail (1 MB) of that file and builds the last 15 actions exactly
as `extract.py` did. Failures, notes and result tails are all in the transcript.

The path is read only when it is the session's own Claude Code transcript:
absolute, normalized, shaped `<.claude* config home>/projects/<encoded
cwd>/<session_id>.jsonl` with a UUID session id — checked again on the
symlink-resolved path. Anything else records one `no-transcript` row per session
and is never read.

**Window parity is proved, not assumed.** The TypeScript builder
(`buildActions` + `renderWindow`) was run against 3,000 real research windows
(`windows.jsonl`, each recording its source transcript and offset). Before the
review-round scrub change it reproduced all 3,000 byte-for-byte — including
Python's `json.dumps` spacing and code-point (not UTF-16) slicing, both of
which it first got wrong on 5/300. After it (below), 2,904/3,000 are
byte-identical; each of the other 96 differs because a secret-shaped span
(labelled secrets, JWTs, bot tokens, URL credentials, an Anthropic key) is now
redacted before the cut, which in 28 of them only moves where the cut falls.

**Scrubbed before any cut** (review round 1). Cutting first — as the harness
did — can slice a secret so no pattern matches the surviving part (a private-key
body whose header the tail cut removed was proven to leak). So each raw field
(command, edit strings, other tools' input, result text, note) has a bounded
4,096-character slice scrubbed with `scrubForStore` before it is cut; a field
showing a private-key marker is withheld whole. The finished window is scrubbed
again before it leaves the machine.

### Cadence

`observe()` on each PostToolUse is a counter. Every 5th action per session
(`CIRCLES_STRIDE`), a detached check runs over the last 15 actions. Fewer than
15 actions in the transcript ⇒ no call, no row. Only PostToolUse events count
toward the stride, so a stretch of pure failures is checked at the next
successful action; the window still contains the failures.

### The question

Verbatim from `runjev.mjs`: the five-way choice (circling / polling /
converging / normal / cannot_tell) with the measured criteria text, asked in
both option orders in the one call (order flips moved ~6% of windows, so the
log keeps both for later analysis). **Would-nudge = forward-order P(circling)
≥ 0.5**, the held-out working threshold.

### Cooldown accounting

As if nudging: after a would-nudge, the same session's next 30 minutes of
over-threshold checks are logged `wouldNudge: false, cooldown: true`. The log
therefore shows the real would-fire rate.

### Rows (content-free)

`logs/jev-circles-shadow.jsonl`, one row per check:
`{kind:'check', ts, session, label, confidence, pCircling, labelRev,
pCirclingRev, wouldNudge, cooldown?, errorActions, ms}`, or
`{kind:'skipped', ts, session, reason}` with reason in a closed set:
`disabled-no-key`, `no-transcript`, `short-window` (a full 1 MB tail that
still holds fewer than 15 actions; all three once per session), `daily-cap`
(once per day), `busy`, `scrub-error`, `timeout`, `http-error`, `model-mismatch`,
`no-answers`. No window text, no vendor error body.

### Read route

`GET /jev-circles/summary` (Bearer, like every route): checks run,
would-nudges, cooldown holds, label counts, skip reasons, per-session
`{checks, wouldNudges, lastTs}`. 503 when not constructed. Reads at most the
last 5 MB of the log.

### Bounds and floors

- **Delivers nothing.** No session, user or topic receives anything; no
  decision path reads the log.
- **Secrets:** each raw field is scrubbed before it is cut, then the window is
  scrubbed again before it leaves the machine; a scrub error or truncation
  sends nothing (`scrub-error`).
- **Spend:** a daily cap on attempted calls (default 2000 ≈ $0.20/day), seeded
  from the log on each new day so a restart does not reset it; at most 2 calls
  in flight (`busy` otherwise); fetch abort at `timeoutMs` (default 1500, max
  10000). Every call metered as feature `jev-circles-shadow` in feature metrics.
- **Stop:** `intelligence.jevCirclesShadow.enabled` is read live on every
  action; explicit `false` stops it on the next action with no restart.
- **Never on the hook path:** `observe()` is synchronous and cannot throw; the
  hook route's response is unchanged.
- **Memory:** at most 500 sessions tracked, least recently active dropped.

### Config

```json
"intelligence": { "jevCirclesShadow": { "timeoutMs": 1500, "maxChecksPerDay": 2000 } }
```

`enabled` deliberately omitted: dev-gated (live on a development agent, dark on
the fleet), registered in `DEV_GATED_FEATURES`. Needs the vault
`typesafe_api_key`; only the dev agent holds one. Reaches existing agents via
`applyDefaults` add-missing.

### Migration parity and awareness

- `hook-event-reporter.js` is built-in and always overwritten by
  `migrateHooks()`; both copies (init.ts and PostUpdateMigrator) gain the field.
- A `### Jev Circles Shadow` CLAUDE.md card in `generateClaudeMd` and
  `migrateClaudeMd` (content-sniffed), and in the framework shadow markers.

## Decision points touched

None. This adds no block, allow, filter or delivery. It is a measurement whose
output only a person reads.

## Multi-machine posture

Machine-local by design: each machine logs the sessions it hosts, from
transcripts on its own disk. The summary is per machine. The research question
is a rate, which per-machine logs answer.

## Framework generality

Claude Code only, stated plainly. The window format and the measurement are
Claude Code transcript shapes. A Codex or Gemini session's transcript path
fails the shape check or parses to no actions, so it records one
`no-transcript` row per session, or nothing. The awareness card says so.

## Known gaps (what this measurement cannot see)

- **Only the fine-grained loop.** A 15-action window is about 5 minutes. The
  review-round loop Justin's rule is really about spans hours and needs a
  different question; the research did not measure it and this does not claim
  it.
- **Guard-rejection loops** (the same message sent into the same hook three
  times) were Jev's main miss in the research. The shadow will record them as
  whatever Jev says.
- **Precision is unknown live.** The research estimated 1 true nudge for every
  1–3 false ones at the natural rate. Finding the real ratio is the point of
  the soak.

## Tests (three tiers)

- Unit (`tests/unit/jev-circles-shadow.test.ts`): window format per tool,
  torn lines, redaction; scrub-before-cut (a PEM body whose header was cut, a
  token across the command cut, a labelled secret before the tail); the path
  guard on both sides, including a symlink out of the projects dir; the
  short-window blind-spot row; cadence; the exact
  request (model pin, questions, criteria order, scrubbed); threshold on both
  sides of 0.5; cooldown inside and past 30 minutes and per session; every skip
  reason; the daily cap across a restart and a new day; live kill switch;
  metering; summary; the dev gate on both sides; replay of 9 recorded Jev
  answer shapes from the research run (unsure, boundary, order-flipped) and the
  live probe response.
- Integration (`tests/integration/jev-circles-shadow-routes.test.ts`): real
  `createRoutes` + real `HookEventReceiver`; five PostToolUse posts with a real
  transcript file drive one check; summary 200 with the counts; 503 when not
  constructed; non-tool events never reach it.
- E2E (`tests/e2e/jev-circles-shadow-lifecycle.test.ts`): the migrator writes
  the config block, card and hook script into a real agent home; the
  **migrated hook script is executed** with Claude Code's real PostToolUse
  stdin shape against a real listening server; on a development agent a check
  is logged and the summary is alive; on the fleet no vendor call.

Live evidence (2026-09-30, real vault key, real Jev, real transcripts, through
the real module): the author's own session read `normal` (P(circling) 0.04);
three research-labelled circling episodes read circling at 0.93, 0.71 and 0.88
(research: 0.96, 0.71, 0.88).

## Rollback

Set `intelligence.jevCirclesShadow.enabled: false` (live, no restart), or
revert the commit. The extra hook field is ignored by every other consumer.
Nothing to repair: the only state is the log file.
