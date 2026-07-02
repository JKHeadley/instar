# Side-Effects Review — Slack files.info self-verify fix + F2 ghost-text exclusion in StuckInputSentinel

**Version / slug:** `p05-filesinfo-ghosttext`
**Date:** `2026-07-02`
**Author:** Echo (autonomous, roadmap 0.5)
**Second-pass reviewer:** self, second pass over the final diff (Tier 1)

## Summary of the change

Two code halves of roadmap item 0.5, both grounded in 2026-07-02 live evidence:

1. **Slack files.info self-verify** (`src/messaging/slack/SlackAdapter.ts`):
   the startup self-verify probed `files.info` with the malformed synthetic id
   `F000SELFTEST`; Slack rejects that id at server-side ARGUMENT VALIDATION
   (`invalid_arguments`) before lookup, and the old classifier counted that as
   an unexpected FAILURE — a healthy adapter red-flagged itself at every boot.
   Fix: (a) probe with a WELL-FORMED synthetic id (`F0000000000`) so a healthy
   workspace answers `file_not_found`; (b) extract the classification into an
   exported pure function `classifyFilesInfoSelfTest()` that treats
   `invalid_arguments` as what it proves (endpoint + auth + transport all
   answered) while `missing_scope` and unknown errors remain failures; (c) use
   `SlackApiError.slackError` (the structured code) when available instead of
   substring-matching the whole message.

2. **F2 ghost-text exclusion** (`src/core/StuckInputSentinel.ts` +
   `src/core/SessionManager.ts`): the sentinel treated Claude Code's DIM
   model-generated composer suggestion (SGR 2, `ESC[0;2m`) as stuck real input
   and fired 4 Enter presses at it (live stuck-input-events.jsonl). Fix: before
   any keypress on the generic `❯`-prompt path, re-capture the pane WITH ANSI
   escapes (new `SessionManager.captureOutputAnsi`, `capture-pane -e`) and
   classify the stuck text's presentation: `real` → recover as before; `ghost`
   (entirely dim) → never press keys, sticky-exhaust until the text changes;
   `inconclusive` (capture failed / frames raced / mixed styling) → LOG-ONLY
   this tick, re-assess next tick. One observability event per stuck text
   (`ghost-text-skip` / `ghost-check-inconclusive`, outcome `skipped`).

## Decision-point inventory

- **Added** (`StuckInputSentinel.evaluateSession`): the ghost-text gate — a new
  refusal branch between "fire-eligible" and "fire keypress" on the generic
  prompt path only. The codex marker path is exempt by construction (it only
  fires at the exact text we ourselves injected). Escalation (tier C) is
  unreachable for ghost text: attempts only accrue through this gate.
- **Added** (`classifyPromptTextPresentation` + `parseAnsiDimLines`): pure
  classification logic. Only the SGR dim attribute (2 / 22 / reset) is the
  ghost tell; extended-color params (`38;5;n`, `38;2;r;g;b`, colon forms) are
  skipped so a truecolor component `2` is never misread as dim. The ANSI
  frame's own prompt extraction must reproduce the plain frame's text EXACTLY,
  or the verdict is `inconclusive` — the styling verdict is always about the
  same characters the detection saw.
- **Modified** (`SlackAdapter._selfVerify` check 2): outcome classification
  moved to `classifyFilesInfoSelfTest()`; `invalid_arguments` reclassified
  fail → pass. `missing_scope` and unknown errors keep failing.

## FAIL-DIRECTION (the load-bearing property)

**The sentinel change fails toward LOG-ONLY, never toward Enter.** Every
uncertain path — ANSI capture unsupported, capture returned null, capture
threw, the two frames raced (text mismatch), unparseable escapes, mixed
styling — resolves to `inconclusive`, which withholds the keypress for that
tick and logs one event. `inconclusive` is deliberately NOT sticky: a raced
capture self-heals next tick, so a genuinely stuck message is recovered at most
a few ticks late; a persistent failure keeps failing toward not pressing.
Pressing Enter at model-fabricated text is the unsafe direction; a delayed
recovery is the safe cost. The invariant encoded: the sentinel never
auto-submits text the user (or an authorized injector) did not actually type.

## Roll-up across the seven review dimensions

1. **Over-block**: the ghost gate could suppress recovery of REAL stuck input
   if the classifier misfires. Mitigations: color is deliberately NOT a tell
   (only SGR 2); a plain no-SGR frame classifies `real` (legacy behavior
   preserved — proven by the pre-existing suite passing with the default stub);
   `inconclusive` is transient, re-assessed every fire-eligible tick; truecolor
   and 256-color params are param-skipped. Both sides tested.
2. **Under-block**: ghost text that Claude Code someday renders at NORMAL
   intensity would not be caught — but then it is visually indistinguishable
   from typed text and no capture-based tell exists; the dim attribute is the
   entire live-evidenced signature. The codex-marker exemption cannot leak: it
   requires a marker WE injected.
3. **Silent failure**: none added. Every skip logs exactly one
   `stuck-input-events.jsonl` row (bounded: one per stuck text, not per tick).
   `captureOutputAnsi` returns null on failure exactly like `captureOutput`.
4. **Authority creep**: none. The sentinel LOSES authority (a new refusal
   branch); nothing gains a new write path. The Slack change alters only a
   boot-time diagnostic verdict, no message flow.
5. **Fleet blast radius**: both changes are always-on but strictly narrowing.
   Slack: only installs with a Slack adapter + `files:read` scope run check 2;
   the reclassification can only flip a false-red to green. Sentinel: one extra
   `tmux capture-pane -e` per fire-eligible tick per stuck session (rare;
   bounded by the same tick cadence that already captures panes).
6. **Rollback**: single-commit revert. No config keys, no migrations, no state
   format changes. The new JSONL `action` values are additive to an existing
   log consumers already treat as free-form.
7. **Observability**: new `ghost-text-skip` / `ghost-check-inconclusive`
   events in `stuck-input-events.jsonl`; Slack self-verify detail strings name
   the exact outcome (`argument validation` vs `file_not_found`).

## 3. Level-of-abstraction fit

Right layer, both halves. The ghost gate lives INSIDE the sentinel's own
fire path (the only place a keypress originates), not as a parallel filter in
front of it — the same layer that already hosts the activity-indicator refusal
and the codex-marker strategy choice. The ANSI capture primitive lives in
`SessionManager` beside `captureOutput` (its styled twin) rather than being
re-implemented in the sentinel, so future consumers that need rendering (not
just bytes) reuse it. The Slack classification is a pure exported function at
adapter level — the self-verify is a boot diagnostic owned by the adapter; no
higher-layer gate exists (or is needed) for a boot-time health verdict.

## 4. Signal vs authority compliance

**Checkbox: No — this change has no NEW block/allow surface over agent or user
information flow.** The ghost gate is deterministic (brittle-by-nature) logic,
but the only "authority" it holds is the power to make the sentinel DO NOTHING
— it withholds the sentinel's own recovery keypress; it cannot block a message,
gate information, or constrain the user or agent. The dangerous authority
(pressing keys into a live session) is what the sentinel already held; this
change narrows it, fail-safe toward inaction, exactly like the pre-existing
activity-indicator refusal at the same layer. The Slack half changes a
boot-diagnostic verdict string; no flow authority at all.

## 5. Interactions

- **Shadowing:** the gate runs AFTER stuck-detection and the min-ticks window
  and BEFORE `fireStuckInputRecovery` — it cannot shadow detection, escalation
  handling (which runs earlier in the flow but later in the attempt ladder), or
  the verifyInjection race-window skip. Nothing runs after it that expects a
  keypress to have happened (the event log records `skipped` honestly).
- **Double-fire:** none. The gate only ever REMOVES a fire. The one-event-per-
  stuck-text latch (`ghostSkipLogged`) prevents log double-fire.
- **Races:** the plain and ANSI captures are two separate tmux calls; a pane
  repaint between them is detected by exact text-match and resolves to
  `inconclusive` (no press) — the race is handled by construction, not by
  timing assumptions.
- **Feedback loops:** none; the gate writes no state the detector reads.
- **Escalation interaction:** tier-C escalation is unreachable for ghost text —
  attempts only accrue through the gate, so four `real` verdicts must precede
  any escalation request.

## 6. External surfaces

- **Other agents / install base:** behavior narrows only (fewer keypresses;
  a false-red boot check goes green). No API, route, config, or template
  changes. No new dependency.
- **External systems:** the Slack probe now sends `F0000000000` instead of
  `F000SELFTEST` to `files.info` — same call count, same scope, still a
  synthetic id that cannot match a real file.
- **Persistent state:** two additive `action` values in the existing
  `stuck-input-events.jsonl` free-form log. No schema, no migration.
- **Timing/runtime conditions:** tmux `capture-pane -e` support (present in
  every tmux version instar supports; a failure degrades to `inconclusive`,
  i.e. log-only).
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing
  actions added or touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, both halves.** The sentinel observes and recovers
tmux panes that exist only on THIS machine's disk/terminal — the pane, the
capture, and the keypress are all physically local, like the rest of the
stuck-input/watchdog family. The Slack self-verify diagnoses THIS machine's
adapter boot. Neither emits user-facing notices (the sentinel's events are
housekeeping JSONL; the self-verify writes to the boot log), neither holds
durable state that could strand on topic transfer, and neither generates URLs.

## 8. Rollback cost

Single-commit revert, shipped as the next patch. No config keys, no
migrations, no persistent-state cleanup, no agent state repair. During a
rollback window the only regression users could see is the OLD behavior
returning (false-red Slack check line; watchdog pressing Enter at ghost text).

## Test coverage

- `tests/unit/StuckInputSentinel-ghost-text.test.ts` (21 tests): the exact live
  F2 frame refused across 10 ticks; genuine input still recovered; null-capture
  / throwing-capture / raced-frame / mixed-styling all fail toward not
  pressing; truecolor + 256-color params not misread; SGR 22 cancels dim;
  cross-line dim state; wrapped-line ghost; sticky-ghost reset on text change;
  codex path ungated; exactly one observability event.
- `tests/unit/slack-files-info-selfverify.test.ts` (12 tests): classifier both
  sides (ok / file_not_found / invalid_arguments pass; missing_scope /
  invalid_auth / unknown fail); probe id shape; `_selfVerify` wiring-level test
  proving the live regression goes green and failures still fail.
- `tests/unit/StuckInputSentinel.test.ts`: pre-existing suite green with the
  gate in place (default ANSI stub = plain frame = `real`), proving legacy
  recovery behavior is preserved.
