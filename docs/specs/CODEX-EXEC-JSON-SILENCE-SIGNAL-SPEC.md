---
title: Silence sentinel recognizes codex exec --json sessions as actively working
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-EXEC-JSON-SILENCE-SIGNAL.eli16.md
---

# Silence Sentinel Recognizes codex exec --json Sessions

## Problem

The ActiveWorkSilenceSentinel detects a session that was producing output and
then froze mid-task. To avoid flagging a session that is simply idle at its
prompt, the wiring (`OutputActivityTracker`) only surfaces sessions whose most
recent frame `looksActivelyWorking`; an idle frame is marked `paused` and the
sentinel skips it.

`looksActivelyWorking` consults per-framework signatures
(`frameworkActivitySignals.ts`). The codex signatures were derived from the
interactive TUI — `• Working (Ns • esc to interrupt)`, `• Ran ...`, the dot
spinner. But codex JOB and autonomous-spawn sessions run `codex exec --json`,
which emits a JSON EVENT STREAM, not the TUI status line:
`{"type":"thread.started"}`, `{"type":"turn.started"}`,
`{"type":"item.started"|"item.completed"|"item.updated"}`. None of the TUI
patterns match that, so a working `codex exec --json` session reads as NOT active
→ is marked `paused` → is skipped by the silence sentinel.

Consequence: a genuinely-wedged exec-json job is invisible to the silence
watchdog. This was observed live 2026-05-30 — a `codex exec --json`
commitment-detection job frozen mid-turn (last output `{"type":"turn.started"}`)
for 8.5 hours, never detected.

## Scope

Extend the codex `toolCallOrSpinner` signature to recognize the `codex exec
--json` event stream. One file plus a test.

In scope:

- `src/monitoring/frameworkActivitySignals.ts` — add the event-stream
  namespaces (`"type":"thread."`, `"type":"turn."`, `"type":"item."`) to
  `CODEX_CLI_SIGNAL.toolCallOrSpinner`, keeping every existing TUI pattern.

Out of scope: SessionWatchdog's separate `getClaudePid`-only model (it detects
stuck CHILD commands, a different failure than a wedged LLM turn) — tracked
separately; the silence sentinel is the correct owner of the wedged-turn case.

## Design

Add the alternation `|"type":\s*"(thread|turn|item)\.` to the codex regex. A
frame containing any of those structured event markers is `active`, so:

- While the job streams events, the `OutputActivityTracker` sees the pane hash
  change and stamps `lastChangeAt` — the session is silence-eligible.
- When the job freezes (no new events), `lastChangeAt` stops advancing and the
  sentinel reports silence after its threshold (default 15 min), then nudges and
  escalates.

The tracker's existing observed-change requirement is preserved: a session
frozen *before* the tracker first saw it keeps `lastOutputAt: 0` and is still
skipped, so a long-dead pane whose last frame happens to contain an event marker
cannot be flagged en masse on a server restart.

The change is strictly additive — it can only make MORE frozen sessions
detectable, never fewer. It does not touch the framework-agnostic detection
logic, only the codex signature feeding it.

## Testing

- **Unit** (`tests/unit/codexExecJsonSilenceSignal.test.ts`):
  - a `codex exec --json` event frame (`turn.started`, `thread.started`,
    `item.completed`, multi-line tail) → `looksActivelyWorking` true.
  - the interactive TUI signatures still register (no regression).
  - the critical guard holds: the idle codex model-name line
    (`gpt-5.3-codex medium · <dir>`) and the placeholder prompt stay inactive —
    the 2026-05-23 false-positive must not return.
  - empty / unrelated output → false; claude-code detection unaffected (a codex
    JSON frame does not register under claude signals).
- **Regression**: the activity-signal + sentinel-wiring suite
  (frameworkActivitySignals, codex-activity-signal, presence-proxy-codex-
  blindness, sentinelWiring, StallTriageNurse — 143 tests) stays green.

## Risks and non-goals

- A false positive would require a pane literally containing the structured
  marker `"type":"thread."` / `"turn."` / `"item."` outside a codex event stream
  — not normal idle text. The match is anchored to the JSON key form.
- This fixes only the silence sentinel's codex coverage. The wedged-job kill
  (the specific 8.5h process) and the SessionWatchdog stuck-child model are
  separate items.
