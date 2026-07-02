# Slack files.info self-verify fix + ghost-text exclusion in the stuck-input watchdog

<!-- bump: patch -->

## What Changed

Roadmap 0.5, the two code halves (live evidence 2026-07-02):

- **Slack files.info self-verify no longer fails a healthy adapter.** The
  startup self-verify probed `files.info` with the malformed synthetic id
  `F000SELFTEST`; Slack rejects that id at server-side argument validation
  (`invalid_arguments`) before lookup, and the old classifier counted that as
  an unexpected failure — `❌ files.info API` at every boot on a working
  connection. Now the probe uses a well-formed synthetic id (`F0000000000`,
  expecting `file_not_found`), and the classification (extracted to
  `classifyFilesInfoSelfTest`) treats `invalid_arguments` as what it proves —
  endpoint, auth, and transport all answered. `missing_scope` and unknown
  errors still fail.

- **The stuck-input watchdog never presses Enter at ghost text.** Claude Code
  renders a model-generated composer SUGGESTION dim (`ESC[0;2m`); in a plain
  `capture-pane` frame the dim attribute is stripped, so ghost text was
  byte-identical to genuinely stuck input, and the sentinel fired 4 Enter
  presses at a fabricated instruction during the live run (harmless only
  because Enter does not currently accept ghost text — one harness UX change
  away from a watchdog auto-submitting model-fabricated instructions). The
  sentinel now re-captures the pane WITH ANSI escapes (new
  `SessionManager.captureOutputAnsi`, `capture-pane -e`) before any keypress on
  the generic `❯`-prompt path and classifies the presentation: `real` →
  recover as before; `ghost` (entirely dim) → never press, sticky until the
  text changes; `inconclusive` (capture failed / frames raced / mixed styling)
  → **log-only this tick, never Enter** — every uncertain path fails toward
  not pressing. One `ghost-text-skip` / `ghost-check-inconclusive` event per
  stuck text lands in `stuck-input-events.jsonl`. The codex marker path is
  exempt by construction (it only fires at text we ourselves injected).

## What to Tell Your User

<!-- audience: user, maturity: stable -->
- **A watchdog safety fix**: the helper that un-sticks typed-but-unsubmitted
  terminal messages could previously mistake the terminal's dim gray
  auto-suggestion (text nobody typed) for a stuck message and press Enter at
  it. It now checks how the text is actually rendered and refuses to press
  anything at a suggestion — and when it can't tell for sure, it does nothing
  and just logs. Genuinely stuck messages still recover exactly as before.

## Summary of New Capabilities

None user-facing — a boot-diagnostic correctness fix and a watchdog safety
narrowing. New internal primitive: `SessionManager.captureOutputAnsi` (styled
twin of `captureOutput`).

## Evidence

- Live server.log 2026-07-02 18:12:27: `❌ files.info API: Unexpected error:
  Slack API files.info failed: invalid_arguments` on a workspace whose
  download-path check passed — the probe id, not the capability, was at fault.
- Live stuck-input-events.jsonl 2026-07-02: 4 `fired` Enter events at the dim
  suggestion text `tas channel-parity: now test the Slack topic` that no one
  typed.
- 33 new unit tests (21 ghost-text + 12 files.info) covering both sides of
  every decision boundary: the exact live ghost frame refused across
  arbitrarily many ticks; the same text at normal intensity still recovered;
  null/throwing/raced captures, mixed styling, truecolor-component-2, SGR 22,
  cross-line dim state; the live `invalid_arguments` shape goes green while
  `missing_scope`/unknown still fail. Pre-existing StuckInputSentinel suite
  green (legacy recovery preserved). Full lint suite exit 0.
