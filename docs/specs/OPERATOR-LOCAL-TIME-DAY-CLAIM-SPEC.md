---
title: "Operator-Local Time and the DAY_CLAIM Advisory (amendment to Robust Session Time Awareness)"
slug: "operator-local-time-day-claim"
author: "dawn (with echo as reviewer)"
eli16-overview: "operator-local-time-day-claim.eli16.md"
parent-spec: "ROBUST-SESSION-TIME-AWARENESS-SPEC.md"
amends: "ROBUST-SESSION-TIME-AWARENESS-SPEC.md — Component 2 (the injected time line) and the outbound side (a DAY_CLAIM advisory beside TIME_CLAIM)"
parent-principle: "Structure beats Willpower"
status: "draft — pending review"
lessons-engaged:
  - "Structure > Willpower — the agent never converts zones or works out the weekday; the line it reads already says which day it is for the operator"
  - "P2 Signal vs Authority — DAY_CLAIM is inform-only on the existing NOT-SENT advisory slot; it never rewrites or blocks, and re-sending (or --ack-advisory) delivers"
  - "P3 Migration Parity — every agent-installed file changed here (session-start.sh, telegram-topic-context.sh) ships through a concrete PostUpdateMigrator path, with a parity test"
  - "P7 LLM-Supervised Execution — tier0: zone resolution, formatting and the DAY_CLAIM rules are deterministic, no LLM call"
  - "B11 timestamp-check — one clock, labelled with its zone; the machine zone is never shown as if it were the operator's"
  - "Shadow-mode without a forcing function — dryRun ships with numeric flip and rollback thresholds written here, measured from a per-check log, not a remembered intention"
  - "A gate with no flag log cannot prove it ever fired — one row per CHECK (not per flag) from day one, so a quiet log distinguishes 'never fired' from 'never ran'"
  - "Don't add a second formatter — extend src/utils/localTime.ts (formatLocalTimestamp / localTzAbbreviation) with a zone parameter"
  - "L9/B4 — dense spec ships with an ELI16 companion"
supervision: "tier0"
approved: false
approved-by: ""
review-status: "pending review in PR #2237 (Echo approved the direction and the four open-question recommendations 2026-10-20; approved stays false until sign-off)"
---

# Amendment — Operator-local time and the DAY_CLAIM advisory

**Status:** DRAFT, `approved: false`, pending review. Spec only, no implementation in this change.
**Amends:** `ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (approved 2026-06-02). The parent's design stays in force; this changes (a) what the injected CURRENT TIME line says and in which zone, and (b) adds an outbound DAY_CLAIM advisory beside TIME_CLAIM.
**Date:** 2026-10-20 · **Reviewer of the five points:** Echo.

## Origin

On 2026-10-20 the operator, Justin (America/Los_Angeles), told his agent: *"We need to work on your awareness of time... make an update for INSTAR agents that injects the current time or at least check it before every outbound message."* That agent had repeated "before 2:50pm today" for 11 hours, and on Monday night it called a Tuesday deadline "today", because it reasoned in UTC.

Two gaps in what ships today let that happen, both verified against `main` at 76d5a6098:

1. **The injected line has no weekday and is in the machine's zone, not the operator's.** Both injection sites print `date +'%Y-%m-%d %H:%M:%S %z (%Z)'`: `PostUpdateMigrator.getSessionStartHook()` (the `--- CURRENT TIME ---` block in `session-start.sh`) and `PostUpdateMigrator.getTelegramTopicContextHook()` (the same block in `telegram-topic-context.sh`, emitted before the `[telegram:N]` early-exit). A line like `2026-10-20 21:40:12 -0700 (PDT)` makes the agent work out "Monday" itself. That is exactly the computation it got wrong. The zone is whatever the host runs in, which is the operator's zone only by coincidence.
2. **Nothing on the outbound side checks day words.** `OutboundAdvisory.composeTimeClaimAdvisories` (the TIME_CLAIM detector, `src/core/time-claim.ts`) checks only elapsed/remaining/percent claims against an active session clock. "Today", "tomorrow", "Tuesday", "before 2:50pm" are never checked.

## The five points

### 1. The injected line always shows weekday, date and time in the operator's zone

The CURRENT TIME block keeps its delimiters (`--- CURRENT TIME ---` / `--- END CURRENT TIME ---`, which the CLAUDE.md template text in `PostUpdateMigrator` refers to) and its first line becomes, **on every emission, whether or not the zones differ**:

| case | line |
|---|---|
| operator zone known, equal to machine zone | `Tue 2026-10-20 13:25 PDT (operator: same as machine)` |
| operator zone known, different from machine zone | `Tue 2026-10-20 22:25 CEST (operator: Europe/Berlin; machine: Tue 2026-10-20 13:25 PDT)` |
| operator zone unknown | `Tue 2026-10-20 13:25 PDT (machine zone, operator zone unknown)` |
| server unreachable (bash fallback) | `Tue 2026-10-20 13:25 PDT (machine zone, operator zone unknown: server unreachable)` |

The second line keeps an unambiguous instant for anything that compares against UTC timestamps: `ISO: 2026-10-20T13:25:41-07:00`. The third line keeps the existing guidance ("Quote this — do not carry stale clock times from prior context") and adds: *"Say days in the operator's terms: 'today' means the date on line 1."*

"Same as machine" is decided by comparing the formatted wall-clock and abbreviation for the current instant in both zones, not by comparing IANA names. `America/Los_Angeles` and `US/Pacific` are the same for this purpose.

**Where the line is computed.** In the server, so one formatter produces it (point 3). The additive field `operatorNow` is added to the existing `GET /session/clock` response (`src/server/routes.ts`, the route the parent spec added). The existing fields `now`, `nowIso` and `sessions` are unchanged:

```
operatorNow: {
  line: string,            // line 1 above, rendered by formatLocalTimestamp
  iso: string,             // line 2
  zone: string,            // IANA zone the line is rendered in
  zoneSource: 'operator-preference' | 'machine-fallback',
  fallbackReason?: 'no-topic' | 'no-verified-operator' | 'no-user-record' | 'no-timezone' | 'invalid-timezone',
  machineZone: string,
}
```

**Hook wiring.**
- `telegram-topic-context.sh`: the prompt is read and the `[telegram:N]` topic parsed *before* the time block is emitted (today the block comes first). The block is still emitted exactly once on every UserPromptSubmit, before the early-exit. On a `[telegram:N]` turn the hook calls `GET /session/clock?topic=N`; with no topic it calls it without one. It prints `operatorNow.line` / `.iso`. If the call fails or times out (`--max-time 2`), it prints the bash fallback via `date +'%a %Y-%m-%d %H:%M %Z'`, labelled "server unreachable". `emit-session-clock.sh query` already calls the same route on telegram turns. The implementation may fold both into one call, but the CURRENT TIME block must not depend on a SESSION CLOCK existing.
- `session-start.sh`: the same call, with `topic=$INSTAR_TELEGRAM_TOPIC` when set. The block stays after `=== SESSION START ===` and before TOPIC CONTEXT. The existing ordering tests in `tests/unit/PostUpdateMigrator-time-injection.test.ts` keep asserting that.

The bash fallback is a degraded path that already exists today (the current `date` call), kept with a distinct label. It is not a second formatter for the normal path.

### 2. Zone source: one source, resolved the same way on every machine

**Resolution chain (one function, `resolveOperatorZone`, pure given its inputs; new file `src/core/operatorZone.ts`):**

1. **Operator uid for the topic:** `TopicOperatorStore.getOperator(topicId)` (`src/users/TopicOperatorStore.ts`). It returns only *verified* bindings: `isVerifiedTopicOperatorBinding`, established by `setAuthenticatedOperator` from an authenticated Telegram inbound. Asserted records (`POST /topic-operator`) and legacy rows are refused, as everywhere else.
   - With no topic, or no verified binding for this topic on this machine: use the agent's single principal, only when `everVerifiedOperatorUids()` holds **exactly one** uid. This is the existing "exactly one principal" rule that `resolveApprovalOwner` (`src/threadline/PairingInviteTelegram.ts`) already applies. Zero, two or more, or an unreadable history (`null`) means `no-verified-operator`.
   - A record replicated from a peer (`TopicOperatorReplicatedStore`) is **never** an input. That store's load-bearing invariant is that a replicated record is never this machine's answer to "who is my operator", and a display feature is not a reason to weaken it.
2. **The user record:** `UserManager.resolveFromTelegramUserId(Number(uid))` (`src/users/UserManager.ts`). This matches on the `UserProfile.telegramUserId` field.
3. **The zone:** `profile.preferences.timezone` (`UserPreferences.timezone`, `src/core/types.ts`), validated as an IANA zone by constructing `Intl.DateTimeFormat('en-US', { timeZone })`. A throw means `invalid-timezone`.
4. **Fallback:** the machine zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), with `zoneSource: 'machine-fallback'` and the reason. The line then says "machine zone, operator zone unknown". The machine zone is **never** shown as the operator's.

**No new config field for the zone.** The operator's zone is a property of the person, and `UserPreferences.timezone` already exists for it (collected by `UserOnboarding` when `OnboardingConfig.collectTimezone` is on, default off). The feature gate keys in point 4 are feature flags, not a zone source.

**The case the brief asked about exists. A real agent can have no user record for its operator.** Measured on 2026-10-20 across the eight agents on this workstation (`~/.instar/agents/*` plus one project agent), reading each `.instar/users.json` and `state/topic-operators.json`:

| agent | verified topic operator | user record with that `telegramUserId` | `preferences.timezone` on it |
|---|---|---|---|
| echo | yes (Telegram uid) | yes | **unset** |
| gemini | (no operator file) | yes | **unset** |
| sagemind | yes, 6+ topics | **no** (2 users, neither has `telegramUserId`) | n/a (an unrelated user does have one) |
| ai-guy | yes, 6+ topics | **no** (1 user, email channel only) | n/a |
| indra-instar | only an `operator-api-assertion` (Slack uid), so not verified | no | n/a |
| meridian, pi-tas-agent | — | **zero users** | n/a |
| deep-signal | — | 1 user, no `telegramUserId` | unset |

So **today the chain resolves to `machine-fallback` on every one of them.** Points 1 and 4 still work there. They run in the machine zone, honestly labelled, and on this workstation that zone happens to equal the operator's. But the operator-zone behaviour stays inert until the record exists. The amendment names two sub-cases and how each is closed, without a new config field:

- **(a) User record exists but has no timezone** (echo, gemini). Closed by writing `preferences.timezone` onto the existing record. Proposed: a NEW narrow, Bearer-gated route `PUT /users/:id/timezone` (validates IANA, writes through `UserManager.upsertUser`), plus an `instar user timezone <zone>` CLI. No route updates user preferences today; this route would be new. While `zoneSource` is `machine-fallback` with reason `no-timezone` on a topic that has a verified operator, the CURRENT TIME block adds one line: *"Your operator's time zone is not recorded. Ask them once, then record it."*
- **(b) No user record carries the operator's `telegramUserId`** (sagemind, ai-guy, meridian, pi-tas-agent). This amendment **does not auto-create or auto-link a user record**. `users.json` feeds sender validation (`src/core/senderValidationGate.ts`), and linking a uid to a profile is an identity decision, not a display one. The fallback line carries reason `no-user-record`, and the same one-line prompt directs the agent to the existing registration path (`UserManager.addUserInteractive` via onboarding). The alternative, a single agent-level `operatorTimezone` setting (the one case where the brief allowed a new config field), was considered and **rejected** in review (resolved decision 1).

**Pool requirement: the operator zone must resolve the same way on every machine, even when the machines sit in different zones.**

What the code guarantees today, and what it does not:
- `state/topic-operators.json` and `users.json` are file-backed **per machine**. Their WS2.6 replicated kinds (`multiMachine.stateSync.topicOperator.enabled`, `multiMachine.stateSync.userRegistry.enabled`) are **dark by default**. The user-record projection `buildUserRecordData` (`src/core/UserRegistryReplicatedStore.ts`) carries name, channels, permissions, `telegramUserId`, `slackUserId`, `createdAt` and `relationshipContext`, and **not `preferences`**. So the timezone never crosses machines through replication, even when it is switched on. Whether the files converge through git-sync depends on the agent's sync setup. Neither is on `FileClassifier`'s excluded list, but the amendment does not rely on it.
- Therefore **"identical on every machine" cannot be guaranteed by the existing stores alone.** This contradicts the point as stated, and the amendment says so rather than papering over it.

What the amendment specifies so the requirement holds:
1. **The function is machine-independent.** `resolveOperatorZone` takes no input from the host zone except the *fallback*. Two machines with the same inputs (topic binding / ever-verified set, user record) produce the same `zone`, whatever their `TZ`. The pool test below pins this with the two machines in different zones.
2. **Divergent inputs are labelled, never guessed.** A machine missing an input renders `machine-fallback` with its reason. It never shows its own zone as the operator's. So the worst case on a split pool is "one machine says operator zone unknown", never "two machines confidently disagree about the operator's day".
3. **The timezone travels with the user record.** `buildUserRecordData` gains an optional `timezone` field (the IANA string only, clamped like the other free-text fields). It is subject to the WS2.3 PII review that every replicated user field gets, because a zone is coarse location data. When user-registry replication is on, the zone converges wherever the record does.
4. **Divergence is observable.** `operatorNow.zone` and `.zoneSource` are in `/session/clock`, so a pool coherence probe can compare machines for one topic. A mismatch is logged as a coherence finding (wired into whichever pool probe exists at build time; the specific consumer is chosen at build, not invented here).

### 3. Extend `src/utils/localTime.ts`, don't add a second formatter

The functions to extend are **`formatLocalTimestamp(input, opts)`** and **`localTzAbbreviation(d)`** in `src/utils/localTime.ts`. Today `formatLocalTimestamp` builds the string from host-local getters (`d.getFullYear()`, `d.getMonth()`, `d.getDate()`, `d.getHours()`, `d.getMinutes()`), and `localTzAbbreviation` asks `Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })` for the host abbreviation. Six modules import it (`ForwardedTopicContext`, `TopicMemory`, `routes`, `TelegramLifeline`, `commands/server`, `compactionResumePayload`).

Extension:
- `formatLocalTimestamp(input, opts: { date?: boolean; seconds?: boolean; weekday?: boolean; timeZone?: string })`. With `timeZone` set, date and time parts come from `Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year/month/day/hour/minute/second, weekday: 'short' }).formatToParts(d)`. With `weekday: true` the output is prefixed `Tue `. **With neither new option the output is byte-identical to today** (pinned by a test over a fixed set of instants, including both DST edges).
- `localTzAbbreviation(d, timeZone?)` passes `timeZone` through to the same `Intl` call.
- One exported helper, `zonedDateParts(d, timeZone?) → { year, month, day, weekday, hour, minute }`, is the single place the zone arithmetic lives. `formatLocalTimestamp` is rebuilt on top of it, and DAY_CLAIM (point 4) uses it to get "the operator's date and weekday now". This is the one formatter, exposed as parts, not a second one.
- An invalid `timeZone` makes `Intl` throw. The helper does **not** swallow that. `resolveOperatorZone` validates before anything formats, so an invalid zone shows up as `invalid-timezone` rather than a silently host-zoned line.

### 4. DAY_CLAIM advisory beside TIME_CLAIM (inform-only)

**Shape.** It lives in `src/messaging/OutboundAdvisory.ts`. The `AdvisoryCode` union gains `'DAY_CLAIM'`, the static `GUIDANCE` table gains an entry (static text, injection-pinned like the others), and a new `composeDayClaimAdvisories(text, operatorNow)` is a sibling of `composeTimeClaimAdvisories`. The detector is pure and total in a new `src/core/day-claim.ts` (a sibling of `src/core/time-claim.ts`): no I/O, no LLM, and every malformed input degrades to "not detected" (fail-open, like every detector). It is the existing NOT-SENT advisory. `telegram-reply.sh` prints `NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)`, exits 0, and re-sending delivers. It never blocks or rewrites.

**It runs on conversational sends too.** In `POST /messaging/preflight` (`src/server/routes.ts`), DAY_CLAIM runs for every non-script sender kind, automated and conversational, through the same branch TIME_CLAIM uses for non-automated kinds. **This makes DAY_CLAIM the first advisory that evaluates every conversational reply.** Today the only detector the preflight runs on a conversational send is TIME_CLAIM, and that is a no-op unless the topic has an active time-boxed session clock (and is itself dev-gated, `outboundAdvisoryTimeClaim`). A false positive therefore lands on ordinary chat, which is why dryRun comes first. Scope note: only `telegram-reply.sh` calls `/messaging/preflight` today. `slack-reply.sh`, `imessage-reply.sh` and `whatsapp-reply.sh` do not, so DAY_CLAIM reaches Telegram replies only, the same reach as TIME_CLAIM. Extending the preflight to the other channels is out of scope.

**The fix is one look away.** The advisory's `match` (the existing bounded ≤120-char inert field, rendered by `telegram-reply.sh` as `detected: "…"`, the same way TIME_CLAIM renders `claimed X; live clock: Y`) carries the server-computed fact, never message content beyond the matched day word: `"tomorrow" → Wed 2026-10-21; operator's local time now: Tue 2026-10-20 13:25 PDT`. Because it reuses `match`, `telegram-reply.sh` needs no change for this, and no migration of that script is needed.

**Gating.** Config `outboundAdvisory.dayClaim.enabled` OMITTED, resolved through `resolveDevAgentGate`: live on a development agent, dark on the fleet. It is registered in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`) so `tests/unit/devGatedFeatures-wiring.test.ts` guards both sides. `outboundAdvisory.dayClaim.dryRun` defaults `true`. Both use the reachable top-level `outboundAdvisory.*` home with the legacy `messaging.outboundAdvisory.*` fallback, exactly as the TIME_CLAIM gate does in the preflight route. In dryRun the rules run and are logged, but nothing is added to the preflight response, so no NOT-SENT is ever shown. Per-rule override: `outboundAdvisory.dayClaim.rules.<ruleId>.dryRun` lets R1/R2 graduate before R4.

**Rules.** All are evaluated in the **operator's zone** from point 2, and only on text that survives the carve-outs below.

| id | rule | confidence |
|---|---|---|
| R1 `relative-day-vs-date` | One of `today / tonight / tomorrow / yesterday / this morning / this afternoon / this evening` appears in the same sentence as an explicit weekday or calendar date, and the date the relative word means (from the operator's date now) differs from the explicit one. ("The Tuesday deadline is today", sent Monday 21:40 PDT → flag.) | high |
| R2 `weekday-vs-now` | A weekday is asserted as the current or adjacent day ("today is Tuesday", "it's Tuesday", "Tuesday today", "tomorrow, Wednesday", "happy Monday") and it contradicts the operator's local weekday. | high |
| R3 `part-of-day-passed` | `this morning / this afternoon / this evening / tonight` is used with a future marker (`will`, `'ll`, `going to`, `planning to`, `later`) after that period has ended in the operator's zone (bounds: morning <12:00, afternoon <17:00, evening and tonight <24:00). | low |
| R4 `clock-passed-as-upcoming` | A clock time (`2:50pm`, `14:50`) with an upcoming marker (`before`, `by`, `until`, `at … today`, `due`, `deadline`, `starts`, `in time for`) that has already passed in the operator's zone, with a 15-minute grace, today's date only. Deliberately **narrow**: no inference for other days, no ranges. | low |

This is the incident shape. "Before 2:50pm today", said at 21:40, is R4. "Today" for a Tuesday deadline, said on Monday, is R1 *when the message names the day*. A bare "today" with no date and no clock time in the sentence is **not** checkable by a deterministic rule, because the detector cannot know which day the speaker meant. That gap is accepted, and the injected line in point 1 is what covers it.

**Carve-outs (known false positives), applied before any rule:**
- **Quoted text and code.** Fenced blocks, inline code, `>` blockquotes, and text inside straight or curly double quotes are removed. Quoting what someone said "today" is not a claim.
- **Someone else's date.** A sentence that carries an explicit zone or place marker (an IANA name, a zone abbreviation that is not the operator's, `UTC`/`GMT`, `in <Capitalised place>`, `their/his/her/your time`, `local time there`) is skipped for all rules. Example: "their deadline is tomorrow in Berlin."
- **Past tense / reported speech.** For R3 and R4, a sentence with a past marker (`was`, `were`, `had`, `did`, `ago`, `earlier`, `already`, `said`, `told`, `missed`, `passed`) is skipped. R1 and R2 still run, because "yesterday was Tuesday" on a Tuesday is a real contradiction.
- **Conditionals and hypotheticals** (`if`, `would`, `could`) are skipped for R3 and R4.
Each carve-out that suppresses a rule is logged as a `skipped` reason (below), so the over-suppression rate is measurable too.

**Logging from day one: one row per CHECK, not only per flag (Echo's requirements).**
- **Where:** `logs/day-claim-checks.jsonl`, written only by the server (the same single-writer, O_APPEND, size-rotated discipline as `logs/outbound-advisory.jsonl` in `OutboundAdvisoryAudit`; implemented as a second log path on that class so rotation and fail-open are shared). A log-write failure never affects delivery (`@silent-fallback-ok` with the same rationale).
- **One row per rule per preflight:** `{ ts, checkId, topicId, jobSlug, kind, textHash, mode: 'dryRun'|'inform', rule: 'R1'|'R2'|'R3'|'R4', ran: true, flagged: boolean, confidence, skipped?: 'quoted'|'foreign-zone'|'past-tense'|'conditional', lexeme?: <closed-vocabulary token, e.g. 'today' | 'tuesday' | 'clock'>, operatorLocal: 'Tue 2026-10-20 13:25', zone, zoneSource }`. `checkId` groups the four rows of one preflight. `operatorLocal` is the operator-local date and time **the check used**, so a reviewer can tell whether a flag was computed against the right day.
- **When DAY_CLAIM does not run** (gate dark, detector threw, operator-zone resolution threw), one row is still written: `{ ts, checkId, topicId, kind, rule: '*', ran: false, reason }`. A quiet log can then tell "never fired" apart from "never ran", and "never ran" carries a reason.
- **Never the message text.** No text, no `match` string, no sentence fragment. Rows carry `textHash` (sha256, as the existing audit does) and a closed-vocabulary `lexeme`. To adjudicate a flag, a reviewer joins `textHash` (with `topicId` + `ts` within 2 minutes as a fallback join) to the outbound message already held in the agent's own topic history. The log itself never becomes a second copy of what was said.
- **The sender's reaction to each flag (inform mode only; in dryRun the sender is never shown anything).** A `reaction` row `{ ts, checkId, reaction }` is appended when the outcome is known:
  - `acked-unchanged`: the send came back through `/telegram/reply` with `metadata.advisoryAck` and `DAY_CLAIM` among its codes. This hooks the existing `OutboundAdvisoryAudit.recordAck` path; the join is by `topicId` + `textHash`, since the text is unchanged.
  - `fixed-resent`: a later preflight on the same topic, within 10 minutes, is near-identical (the existing `NEAR_IDENTICAL_JACCARD` = 0.4 token-set test in `resolveNearIdentical`) and DAY_CLAIM-clean.
  - `no-resend`: neither within 24 hours. This matches the existing repeated-ignore window, and the existing escalation to the operator already covers silent drops.
  `acked-unchanged` is the sender saying "this flag was wrong". That is the live false-positive signal for the inform phase.

**Coverage denominator: checked in the code (main at 76d5a6098).** The existing audit already writes a row for every conversational preflight that reaches the route, clean ones included. `POST /messaging/preflight` (`src/server/routes.ts:17512`) calls `outboundAdvisoryAudit.recordPreflight(...)` unconditionally at `routes.ts:17580`, for automated and non-automated kinds alike. Non-automated rows are keyed `jobSlug: 'interactive-session'`. `OutboundAdvisoryAudit.recordPreflight` (`src/messaging/OutboundAdvisory.ts:306`) derives `action` as `'advised'` or `'clean'` (`:313`) and appends the row via `appendLine` (`:315`). So no new denominator row is needed. The coverage metric is **DAY_CLAIM `checkId`s in `logs/day-claim-checks.jsonl` ÷ rows in `logs/outbound-advisory.jsonl` with `action ∈ {clean, advised}` and `kind ≠ 'automated'`, over the same window**, joined per request on `(topicId, textHash)` with `ts` within 5 seconds. The metric is deliberately **not** computed from `day-claim-checks.jsonl` alone: a log cannot count the checks it failed to write, so a self-referential denominator would read 100% exactly when the gate is silently not running.

That denominator does not see every conversational send. These paths produce no preflight row, so the metric cannot see them:
- **Advisory switched off:** `outboundAdvisory.enabled = false` returns `{ advisories: [], disabled: true }` at `routes.ts:17531–17534`, before `recordPreflight`. No row is written there, by design. DAY_CLAIM adds nothing on this path either. Those sends are out of scope by operator choice, not missed.
- **The preflight never reached the server:** `telegram-reply.sh` skips the preflight for `SENDER_CLASS=script` (`src/templates/scripts/telegram-reply.sh:299`), and skips it when building the request body failed (`:323`, the python3-unavailable fail-open). A curl timeout or connection error also sends with no server-side row. The coverage ratio is blind to these. They are measured separately as **preflight reach**: conversational `/telegram/reply` deliveries in a window ÷ conversational preflight rows in the same window. The implementation counts deliveries from the reply route's existing delivery record (whichever it is at build time; it is not named here, so as not to cite an API this spec has not read). Preflight reach is reported next to coverage at the day-14 and day-30 checks. It is not a flip condition, because it measures the transport, not DAY_CLAIM.
- **A failed audit append** (`appendLine` swallows write errors, by contract) loses the row from both logs alike. It shows as a drop in total rows, not as a coverage gap.

**Flip and rollback thresholds (numbers, so the flip has a forcing function):**
- **dryRun → inform, R1 and R2:** at least 14 days live on development agents, **and** at least 30 adjudicated would-flags, **and** precision ≥ 90% (at most 3 false positives in 30), **and** check-row coverage ≥ 95%, as defined under "Coverage denominator" below. If 30 flags have not accumulated by day 30, decide on what exists and record the decision.
- **dryRun → inform, R3 and R4 (low confidence):** a stricter bar: at least 20 adjudicated would-flags at precision ≥ 95%. They may stay dryRun indefinitely. The injected line is the main defence for those shapes.
- **Rollback, inform → dryRun, per rule:** over the most recent 50 shown flags, `acked-unchanged` > 30%.
- **Forcing function:** a scheduled check (the existing job/attention machinery; one deduped Attention item, fixed `sourceContext`) computes these numbers from the two logs on day 14 and day 30 and raises the decision to the operator with the figures. The flip itself is a config write, never automatic. The deadline is not left to memory.
- Fleet release (dropping the dev gate) is a separate decision after the inform phase has run on development agents.

### 5. Test plan

All three tiers, following the parent spec's tests section.

**Unit, `localTime.ts`:**
- No new options gives byte-identical output to today for a fixed set of instants (including both 2026 DST transitions in America/Los_Angeles).
- `timeZone: 'Europe/Berlin'` on a host forced to `TZ=America/Los_Angeles` renders Berlin's date, weekday and abbreviation. `weekday: true` prefixes `Tue `.
- An invalid zone throws, and is not silently host-zoned.

**Unit, `resolveOperatorZone`:** verified binding plus a user with a timezone gives `operator-preference`. Asserted binding gives `no-verified-operator`. Ever-verified set of exactly one with no topic binding resolves through that one uid, while two uids or an unreadable history (`null`) does not. No user with that `telegramUserId` gives `no-user-record`. User without a timezone gives `no-timezone`. Bad IANA string gives `invalid-timezone`. A replicated peer record present but no local binding still gives `no-verified-operator` (the invariant holds).

**Unit, the date boundary (both sides):** operator zone `America/Los_Angeles`, fixed instants:
- **23:30 PDT Mon 2026-10-19** (= 06:30 UTC Tue): the line says `Mon 2026-10-19 23:30 PDT`. DAY_CLAIM: "the Tuesday deadline is today" flags (R1); "the deadline is tomorrow, Tuesday" does not flag.
- **00:30 PDT Tue 2026-10-20** (= 07:30 UTC Tue): the line says `Tue`. "The Tuesday deadline is today" does not flag; "tomorrow (Tuesday)" flags (R1).
- **A UTC-across-midnight case where the zones disagree on the date:** 17:30 PDT Mon (= 00:30 UTC Tue). "Today is Tuesday" flags (R2), because UTC's date must never leak into the check.

**Unit, weekday:** a matching weekday ("it's Tuesday" on Tuesday) gives no flag; a mismatching one ("it's Wednesday" on Tuesday) gives R2.

**Unit, passed time:** at 21:40 operator-local, "I'll send it before 2:50pm today" flags R4 (low); "the meeting was at 2:50pm today" does not (past tense); "if it had been before 2:50pm" does not (conditional); "before 2:50pm Berlin time" does not (foreign zone); a quoted "before 2:50pm today" does not (quoted); "before 9:50pm today" at 21:40 does not (still upcoming); "before 9:30pm today" at 21:40 does not (passed by only 10 minutes, inside the 15-minute grace).

**Unit, carve-outs:** a fenced code block containing "today is Monday" does not flag. "Their deadline is tomorrow in Berlin" does not flag. Each suppression writes a `skipped` row.

**Integration, `POST /messaging/preflight`:**
- **dryRun log:** in dryRun a would-flag returns `advisories: []` (no NOT-SENT) and writes four rule rows with `flagged: true` on the right rule, `mode: 'dryRun'`, `operatorLocal` set, and no message text anywhere in the row (assert that the text, and every word of it outside the closed vocabulary, is absent).
- **A flagged send AND an unflagged send each write rows (Echo's requirement 3).** Two preflights, one that flags and one that does not, produce rows for both. The test fails if the clean one wrote nothing, so an empty log can only mean nothing was checked, never a broken logger.
- **Gate dark:** one `ran: false` row with a reason.
- **Inform mode:** a flag returns `DAY_CLAIM` with `match` containing `operator's local time now:`; an `--ack-advisory` resend writes `reaction: 'acked-unchanged'`; a near-identical fixed resend writes `fixed-resent`.
- `GET /session/clock` returns `operatorNow` with every field, and leaves the existing `now` / `nowIso` / `sessions` unchanged (back-compat).

**Integration, the pool with machines in different zones:** two servers on one shared fixture `users.json` + `topic-operators.json`, one process with `TZ=America/Los_Angeles` and one with `TZ=Europe/Berlin`, and the operator's `preferences.timezone = 'America/Los_Angeles'`. `/session/clock?topic=N` on both returns the same `operatorNow.zone`, the same `line` up to `(operator: …)` suffix, and the same `zoneSource`. Only `machineZone` differs. The Berlin machine's line reads `(operator: America/Los_Angeles; machine: … CEST)`. Removing the timezone on the Berlin machine only makes it render `machine zone, operator zone unknown`, and **never** a Berlin time presented as the operator's. Plus a unit test that `buildUserRecordData` carries `timezone` when present and clamps it.

**Migration parity (per the parent spec's Migration parity section):**
- `session-start.sh` and `telegram-topic-context.sh` are rewritten unconditionally by `PostUpdateMigrator.migrateHooks()` from `getSessionStartHook()` / `getTelegramTopicContextHook()`. Codex agents run the same files through `src/core/installCodexHooks.ts`. The parity test runs `migrateHooks` over a fixture `.instar/` that holds **today's** hook text (the `'%Y-%m-%d %H:%M:%S %z (%Z)'` format) and asserts that the migrated files call `/session/clock`, carry the `%a` fallback format and the `operator zone unknown` label, and still emit the block before the `[telegram:N]` early-exit. `tests/unit/PostUpdateMigrator-time-injection.test.ts` currently pins the old shape (the `NOW=$(date +` call, the `'%Y-%m-%d %H:%M:%S %z (%Z)'` format string for both hooks, and the output regex); those assertions are updated in the same PR, not deleted, and its ordering assertions (after `=== SESSION START ===`, before TOPIC CONTEXT, before the `[telegram:N]` early-exit) are kept as they are. The end-to-end case runs the generated hook with the server down and asserts the fallback line shape `^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \(machine zone, operator zone unknown: server unreachable\)$`.
- `telegram-reply.sh` is unchanged, because the operator-local time rides in the existing `match` field, so no migration is needed. The test asserts that the current script renders a DAY_CLAIM `match` verbatim.
- New agents get the same hook text through `init`, which uses the same generators.
- Code-only pieces (`/session/clock` field, preflight branch, `localTime.ts`, `operatorZone.ts`, `day-claim.ts`) reach existing agents on update.

**E2E:** a production server boots with a fixture user that has a timezone. A simulated UserPromptSubmit through the generated `telegram-topic-context.sh` contains the operator-zone line. A conversational `telegram-reply.sh` send in inform mode, with "the Tuesday deadline is today" at a fixed Monday instant, prints `NOT SENT — advisory` with the DAY_CLAIM block, and `--ack-advisory` delivers.

## Conformance gate

`instar spec conformance` (run 2026-10-20 against the echo agent's server; 92 standards, registry canary ok) flagged four possible violations. Each is answered here. None is resolved by assertion alone; the reviewer decides.

1. **Signal vs. Authority: "a deterministic rule withholds a message until resend/ack."** This is true of the existing NOT-SENT advisory slot, which TIME_CLAIM, JARGON, RAW_FILE_PATH and LOCALHOST_LINK already use (spec `outbound-jargon-filepath-gap`). The hold costs one re-run, and `--ack-advisory` always delivers unchanged. DAY_CLAIM does add a new *surface*: every conversational reply. That is why it ships dryRun (no hold at all) with numeric precision bars before any hold is shown, and with a per-rule rollback on the override rate. If review judges that a hold on ordinary chat is authority even so, the fallback design is to keep DAY_CLAIM permanently in a "deliver and annotate" mode: send, then log and inject the correction into the next turn. That trades catching the error before the operator reads it for zero friction.
2. **A Refusal Stays a Refusal: "NOT-SENT exits 0."** This is pre-existing `telegram-reply.sh` behaviour, deliberate and commented in the script: a non-zero exit triggers queue/retry semantics in callers, and the first stdout line is the literal `NOT SENT — advisory …`. This amendment does not change it. Whether that contract should change is a question for the advisory spec, not this one.
3. **Always a Multi-Machine Entity: "operator zone propagates only via dark-by-default replication."** Agreed, and stated in point 2. The mitigation here is that a machine without the input labels its fallback and never substitutes its own zone as the operator's, and that the zone is added to the replicated user record. A full fix means user-registry replication being on for pools, which is outside this amendment. Review decided this is not a precondition (resolved decision 3).
4. **No Manual Work: "remediation asks the agent to ask and record."** The operator's zone is a fact only the operator can give. Inferring it, for example from the machine, is the very mistake this amendment exists to stop. The manual part is one question to the operator, once; the agent does the recording itself through the new route. Case 2b (linking a user record) stays manual on purpose because it is an identity decision.

## Decision points touched

- **`POST /messaging/preflight`** gains a detector that runs on every non-script Telegram send, conversational ones included. Inform-only; dryRun first; dev-gated.
- **`GET /session/clock`** gains an additive read-only field. No gate.
- **New write route (proposed):** `PUT /users/:id/timezone` writes one validated preference field. Bearer-gated, no identity effect.
- No existing gate is modified. TIME_CLAIM is untouched.

## Out of scope

- Inferring which day a bare "today" refers to. The injected line covers that; a deterministic detector cannot.
- Slack, iMessage and WhatsApp reply scripts (they do not call the preflight today).
- Auto-creating or auto-linking user records for an operator (an identity decision; see 2b).
- Rewriting the harness system-prompt `currentDate` (host-owned; the parent spec's B11 reconciliation still applies).

## Open questions: resolved

Echo agreed with all four recommendations on 2026-10-20 (PR #2237). They now stand as decisions. `approved` stays `false` until formal sign-off.

1. **Case 2b (no user record for the operator):** link through the existing onboarding path. No agent-level `operatorTimezone` setting; a setting would be a second source of truth for a fact that belongs to the person.
2. **Zone from the operator's own words in chat:** no for v1. The zone is written only explicitly, through `PUT /users/:id/timezone` or the CLI.
3. **User-registry replication as a precondition in pools:** no precondition. The per-machine `zoneSource` is surfaced in the pool probe, so divergence is visible.
4. **R3 and R4 dryRun-only indefinitely:** acceptable, with the day-30 review deciding whether to delete them.

## Sequencing: two increments, each step a gated PR

**Increment 1, the injected operator-local line plus recording the zone. Ships first, on its own, with no DAY_CLAIM code in it.**

*Precondition: a real agent exercises the operator-zone path from day one.* Before increment 1 is declared done, **echo's own user record must carry a timezone**, so at least one live agent resolves `zoneSource: 'operator-preference'` rather than the fallback. Echo is the agent this works on directly: its `users.json` holds user `telegram-7812716706` with `telegramUserId: 7812716706` and no `preferences.timezone`. Its `state/topic-operators.json` holds verified (`authenticated-inbound`) bindings to that same uid, for topics including 1 and 2169. So the chain resolves to that record as soon as the field exists. The zone to write is `America/Los_Angeles`, the operator's stated zone (Justin, 2026-10-20). It is written through the step-1d route once that route is live on echo, as the route's first real use, not by hand-editing `users.json`. Acceptance check: on echo, `GET /session/clock?topic=1` returns `operatorNow.zoneSource = 'operator-preference'` and `operatorNow.zone = 'America/Los_Angeles'`, and the next injected CURRENT TIME block reads `(operator: same as machine)` rather than `(machine zone, operator zone unknown)`. Until that check passes, increment 1 is shipped but not done.

- **1a.** `localTime.ts` zone extension + `zonedDateParts` + byte-identity tests. *(Was step 1.)*
- **1b.** `resolveOperatorZone` + `operatorNow` on `/session/clock` + the pool test + the `buildUserRecordData` timezone field. *(Was step 2.)*
- **1c.** The hook changes in `getSessionStartHook` / `getTelegramTopicContextHook` + migration-parity tests. *(Was step 3; points 1–2 become visible to agents here.)*
- **1d.** `PUT /users/:id/timezone` + `instar user timezone <zone>` CLI + the one-line "record your operator's zone" prompt. *(Was step 5. It must land in increment 1, or the precondition above has no sanctioned write path.)*
- **1e.** The echo precondition above, then its acceptance check.

**Increment 2, DAY_CLAIM. Starts only after increment 1 is done, including the echo acceptance check.** DAY_CLAIM evaluates day words against `operatorNow`, so building it on top of an operator zone no real agent has resolved would make every early would-flag a fallback-zone flag, and its dryRun numbers would measure the fallback rather than the rules.

- **2a.** `day-claim.ts` + `DAY_CLAIM` in `OutboundAdvisory.ts` + `logs/day-claim-checks.jsonl` (per-check rows, `ran:false` rows, reaction rows) + the `DEV_GATED_FEATURES` entry, shipped dryRun. *(Was step 4.)*
- **2b.** The day-14 / day-30 threshold check (coverage against the denominator defined in point 4, preflight reach reported next to it), then the inform flip as a config write after review of the numbers. *(Was step 6.)*
