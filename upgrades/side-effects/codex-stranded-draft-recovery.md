# Side-Effects Review — Codex stranded-draft recovery

**Version / slug:** `codex-stranded-draft-recovery`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Make the stuck-input recovery path codex-aware so an inbound message delivered to a
BUSY codex session is no longer silently stranded as an unsubmitted draft. Three
pieces: (1) `isMarkerStuckAtPrompt` now recognizes codex's `›` prompt char in
addition to Claude's `❯`; (2) a new in-memory `strandedDraftMarkers` map on
`SessionManager` records the injected-message marker for codex injections, with a
shared static `extractInjectionMarker`; (3) `StuckInputSentinel` gains a codex pass
that uses MARKER-based detection (immune to codex's dim empty-prompt placeholder) and
fires the existing escalating Enter recovery once codex goes idle. Claude paths are
untouched.

## Decision-point inventory

- **`StuckInputSentinel.evaluateSession` — codex vs Claude detection branch.** Both
  sides covered by tests: codex-with-marker → marker-based; everything else →
  existing `extractPromptText`.
- **`isMarkerStuckAtPrompt` — prompt-char match (`❯` OR `›`).** Both chars tested,
  plus the negative (marker absent) and the placeholder-immunity case.
- **`rawInject` — record marker only when `framework === 'codex-cli'`.** The
  non-codex branch records nothing (Claude behavior byte-identical).

## 1. Over-block

**What legitimate inputs does this change reject?** None. The change adds no gate and
rejects no input. It only *adds* a recovery action (an Enter keypress) for codex
sessions that were previously never recovered. The recovery is bounded (≤4 attempts)
and only fires when the pane is idle (no active-work footer) and the injected marker
is still visibly stuck at the `›` prompt.

## 2. Under-block

**What does this still miss?** The marker map is in-memory, so a codex message
injected and stranded immediately before a server restart (with no subsequent
message) loses its marker and is not recovered — a strictly rarer compound case than
the observed bug (no restart occurred). Documented in the spec as a follow-up
(durable marker store). Also unchanged: the verifyInjection in-process fast path is
still bounded to 6.5 s; codex busy-long recovery deliberately relies on the
persistent sentinel, not verifyInjection.

## 3. Level-of-abstraction fit

**Right layer?** Yes. Prompt-char knowledge lives in `isMarkerStuckAtPrompt` (the one
shared marker matcher already used by both verifyInjection and the sentinel). The
marker map lives on `SessionManager` next to `rawInject`/`verifyInjection` (the single
injection chokepoint). The codex recovery decision lives in `StuckInputSentinel`,
which already owns persistent stuck-prompt recovery. No new module, no new process.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. The sentinel is a recovery *signal* with the smallest
possible action surface — a single bounded Enter keypress, exactly as for Claude. It
gates nothing, blocks no message, and a false-positive Enter against an empty prompt
is a harmless no-op (the pre-existing design invariant). The marker recording in
`rawInject` is best-effort and never throws (no-ops on a too-short marker).

## 5. Interactions

- **`pendingInjections` (response-verification map):** deliberately NOT reused. That
  map clears on first session output, which for a busy codex session happens while
  the draft is still stranded. The new `strandedDraftMarkers` map clears only when the
  marker leaves the prompt, so the two lifecycles stay independent and correct.
- **`verifyInjection`:** now also clears the stranded-draft marker on confirmed
  submit, and benefits from the `›`-aware matcher for the idle-fast codex case.
- **`isPaneActivelyWorking` / `CLAUDE_WORKING_INDICATORS`:** reused unchanged — codex
  shares the `esc to interrupt` footer hint, so the working-skip is correct for codex.
- **GC:** the sentinel clears markers for sessions no longer running and on
  `tmuxSessionExists` false; a newer injection supersedes an older marker.
- No interaction with the SessionReaper, CompactionSentinel, RateLimitSentinel, or any
  gate. Idempotent across ticks.

## 6. External surfaces

No new HTTP routes, no config keys, no Telegram, no new on-disk files. The only
observable external surface is one additional row in the existing
`stuck-input-events.jsonl` audit log when a codex draft is recovered (same format and
log as the Claude path already uses). No migration required — the change is pure
in-process recovery logic that ships with the server binary and is live on restart;
no agent-installed file (`.claude/settings.json`, `.instar/config.json`, CLAUDE.md
template, hook script, skill) is touched, so the Migration Parity Standard does not
apply.
