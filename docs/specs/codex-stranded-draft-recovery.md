---
title: Codex stranded-draft recovery — inbound messages to a busy codex session no longer silently dropped
date: 2026-05-31
author: echo
status: in-flight
review-convergence: diagnosis-2026-05-31
approved: true
approved-by: Justin
approved-via: Telegram topic 17481 ("approved", 2026-05-31, in response to the live diagnosis + plain-English fix overview)
eli16-overview: codex-stranded-draft-recovery.eli16.md
companion-spec: context-wedge-sentinel.md
---

# Spec — Codex stranded-draft recovery

**Date:** 2026-05-31 · **Author:** echo · **Status:** in-flight

## Triggering incident

Justin sent a message to Codey (a `codex-cli` agent) in the middle of an 8-hour
autonomous run (topic 1052, "Chat with Codey"). The message was relayed to the
session but Codey never saw it or responded — the user only saw the autonomous
run's own progress heartbeats and assumed he was ignored.

Live forensics on Codey's tmux pane found the message sitting verbatim in the
codex input box as an **unsubmitted draft** (`› [telegram:1052 …] If we continue…`
with the footer hint "tab to queue message"), three hours after delivery, on a
turn that had long since ended (`─ Worked for 37m 29s ─`). Pressing Enter once
submitted it cleanly and Codey engaged substantively.

## Root cause

Two framework differences compound into a silent message drop:

1. **Codex does not auto-submit queued input.** Claude Code's readline QUEUES a
   message typed while a turn is in flight and auto-submits it when the turn
   ends — so a mid-turn delivery is self-healing. Codex's TUI does NOT: a message
   typed while codex is "Working" is held as an unsubmitted DRAFT and is never
   submitted when the turn ends. The Enter that `SessionManager.rawInject` sends
   is eaten while codex is busy.

2. **The stuck-input recovery was codex-blind.** Both recovery surfaces keyed on
   Claude Code's `❯` prompt character:
   - `SessionManager.verifyInjection` / `isMarkerStuckAtPrompt` — the in-process
     fast path (polls at 500/1500/3500/6500 ms).
   - `StuckInputSentinel` — the durable, restart-surviving backstop (polls every
     10 s) via its generic `extractPromptText` (`❯`-only) reader.

   Codex's idle prompt is `›` (U+203A), so neither surface ever detected a stuck
   codex draft. And even if `extractPromptText` recognized `›`, it could not be
   used directly: codex renders a dim placeholder hint (e.g. "Explain this
   codebase") at an EMPTY `›` prompt that is **byte-identical to real input once
   tmux strips color**, so a generic prompt-text reader would false-fire on every
   idle codex session.

The verifyInjection in-process window (6.5 s) is also far too short for a
multi-minute codex turn, so even a `›`-aware verifyInjection could not cover the
busy-long case. The persistent sentinel is the right mechanism — it just needed
to (a) recognize `›` and (b) avoid the placeholder.

This is a clean instance of the established "codex-blind sentinel" class
(cf. `codex-watchdog-exec-json-blind`, `codex-jsonlexists-claude-only`,
`codex-compactionsentinel-blind`, `codex-ratelimitsentinel-blind`): a recovery
surface built against Claude pane tells that silently no-ops for codex.

## Design — marker-based recovery

The robust, placeholder-immune tell is the **injected text itself**: codex's
placeholder hint never equals the message we injected. So we match a *marker*
(the injected message's first 40 chars) at the prompt rather than reading the
prompt text generically.

### Changes

1. **`isMarkerStuckAtPrompt` recognizes both prompt chars** — `❯` (Claude) and
   `›` (codex). Marker-based, so it cannot false-fire on the codex placeholder.
   This makes the in-process `verifyInjection` fast path recover an idle-but-stuck
   codex draft within its 6.5 s window for free.

2. **`SessionManager.strandedDraftMarkers`** — a new in-memory map keyed by
   tmux session: `{ marker, framework, injectedAt }`. `rawInject` records it for
   **codex** injections after the send. It is deliberately distinct from the
   existing `pendingInjections` map (response-verification: "did the session die
   before replying?"), which is cleared the moment the session emits ANY output —
   for a busy codex session that happens while the draft is still stranded. The
   stranded-draft marker is cleared only when the marker actually leaves the
   prompt (confirmed submit), so it survives a long busy turn. Accessors:
   `recordStrandedDraftMarker`, `getStrandedDraftMarker`, `clearStrandedDraftMarker`,
   `strandedDraftMarkerSessions`, plus a shared static `extractInjectionMarker`.

3. **`StuckInputSentinel` codex pass** — for a session whose stranded-draft marker
   is `codex-cli`, the sentinel uses MARKER-based detection
   (`isMarkerStuckAtPrompt(pane, marker)`) instead of the generic `❯` reader.
   When the pane is idle (not actively working) and the marker is stuck, it fires
   the existing escalating recovery (Enter → Enter → C-m → Enter+sleep+Enter,
   bounded to 4 attempts), then clears the marker once the message submits.
   Non-codex / no-marker sessions keep the existing Claude `extractPromptText`
   path unchanged.

### Why the sentinel, not just verifyInjection

`verifyInjection` is in-process (its timers die on a server restart) and only
polls for 6.5 s. The `StuckInputSentinel` is the durable, restart-surviving,
every-10-s poller built for exactly this — "a message stuck at the prompt that
never submitted." Routing codex recovery through it reuses its escalation,
exhaustion, GC, and audit-log machinery (`stuck-input-events.jsonl`).

## Safeguards

**Never fires mid-turn.** The sentinel skips any pane showing an active-work
footer hint. Codex shares Claude's `esc to interrupt` hint while working
(`Working (… • esc to interrupt)`), so the existing `isPaneActivelyWorking` check
is correct for codex — the sentinel only ever fires Enter once codex is idle.

**Placeholder immunity.** Because detection is marker-based (the injected text),
codex's dim "Explain this codebase" placeholder at an empty `›` prompt is never
seen as stuck — no false Enter, no log spam. Grounded empirically on Codey's
live pane: empty vs draft are byte-identical except the post-`›` text.

**Bounded + idempotent.** Recovery is capped at 4 escalating attempts per stuck
marker, then exhausted until the prompt text changes. A false-positive Enter on
an empty prompt is a harmless no-op (the existing design invariant). The marker
map is GC'd for dead sessions and superseded by any newer injection.

**No Claude regression.** The Claude path (`extractPromptText`, the
`pendingInjections` response-verification map) is untouched. The codex marker is
only recorded for `codex-cli` sessions, so non-codex behavior is byte-identical.

## Known limitation (tracked)

<!-- tracked: codex-stranded-draft-marker-not-restart-durable -->
`strandedDraftMarkers` is in-memory. A codex message injected and stranded
immediately before a server restart (with no subsequent message) would lose its
marker and not be recovered by the sentinel — a strictly rarer compound case than
the one observed (no restart occurred in the live incident). Persisting the marker
to a small state file (like the existing sentinel events log) would extend codex
coverage to the restart case; this is tracked as framework issue
`codex-stranded-draft-marker-not-restart-durable`.
<!-- tracked: codex-stranded-draft-marker-not-restart-durable -->
This is still strictly better than the prior state, where codex recovery was zero.

## Testing

- `tests/unit/codex-stranded-draft-recovery.test.ts` — `extractInjectionMarker`,
  codex-aware `isMarkerStuckAtPrompt` (incl. the placeholder-immunity case and
  Claude no-regression), and the marker-map CRUD against a real `SessionManager`.
- `tests/unit/StuckInputSentinel.test.ts` — codex pass: fires once idle after
  minTicks, refuses while working, placeholder immunity, clears on submit, GCs
  dead sessions, full escalation order.
- `tests/unit/session-injection-verify.test.ts` — verification path intact (the
  recovery-helper locator hardened to find the definition, not the first call site).
