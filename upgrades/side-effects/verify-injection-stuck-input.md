# Side-Effects Review — verifyInjection + StallTriage Fast-Path

## Change Summary

Two additive layers that recover stuck-input failures on Claude Code v2.1.105+
TUIs, where the Enter keypress sent after a bracketed-paste-end sequence is
occasionally eaten by a race with the paste-end handler.

1. `SessionManager.verifyInjection(tmuxSession, text)` — fires 1.5s after every
   `rawInject`. If a 40-char marker from the message is still visible at the
   `❯` prompt, send one extra Enter. Single-shot per injection.
2. `StallTriageNurse` fast-path — at triage time, if the pane shows ≥20 chars
   of text at the `❯` prompt with no processing glyphs, nudge once and skip
   the LLM round-trip.

## Failure Mode Being Fixed

Observed in production:
- Telegram message reaches the agent server
- Server calls `injectMessage` → `rawInject` → bracketed paste + Enter
- Claude Code's readline buffers the paste content but the Enter races the
  `\e[201~` paste-end and is consumed by it
- Message sits at `❯` with no submission; agent appears unresponsive

Justin's screenshot (2026-05-11) shows the exact failure on Claude Code v2.1.139.

## Over-Block Risk

**verifyInjection:**
- Marker requires the first 40 chars (whitespace-stripped, ≥8 chars) to be
  visible at a line containing `❯` within 1.5s of injection.
- False positive requires the pane to show our exact text at a `❯` prompt
  after Claude has already processed and emitted it back. Claude's transcript
  rendering doesn't put `❯` on transcript history lines — only on the active
  input row — so this is structurally implausible.
- Worst-case impact: one extra Enter to an already-submitted message → empty
  Enter in input box, no behavior change.

**StallTriage fast-path:**
- Requires (a) ≥20 chars of text after the `❯` glyph and (b) absence of all
  of `⎿`, `✶`, `⏺`, `Coalescing`, `thinking`, `esc to interrupt`.
- A genuine in-progress turn always has at least one of those glyphs visible
  during the work, so the gate refuses to nudge.
- Worst-case impact: harmless single Enter.

## Under-Block Risk

If verifyInjection misses the stuck state (Enter took longer than 1.5s to be
eaten, marker text was edited out by user, etc.), the StallTriage fast-path is
the recovery backstop — it runs from the existing zombie-detection idle path.
If that also misses, the existing `pasteRetried` mechanism for literal
`[Pasted text #N]` placeholders catches the short-paste path. Three layers
total; legacy behavior is preserved.

## Level-of-Abstraction Fit

- `verifyInjection` is a private method on `SessionManager`, called from
  `rawInject`. Same abstraction layer as the tmux send-keys it verifies.
- StallTriage fast-path is a heuristic guard *inside* `StallTriageNurse`,
  running before the LLM call. Same abstraction layer as the rest of the
  triage logic.

Neither leaks tmux details upward or adds a new public API. Correct level.

## Signal vs Authority Compliance

- `verifyInjection` is a signal-emitting verification (capture pane + check
  marker). It takes one structural action: send Enter. This is the only
  reasonable mitigation at this layer — there is no higher gate that needs to
  authorize a missed Enter resend.
- StallTriage fast-path emits a signal (typed-but-not-submitted heuristic) and
  takes a single bounded action (one Enter). It does NOT replace the LLM gate
  — if the fast-path doesn't fire, full triage runs as before. The fast-path
  is a *short-circuit*, not a *bypass*.

Both layers carry a `DegradationReporter` entry on recovery so the higher
authority (the user / monitoring) sees that a self-heal fired.

## Interactions With Existing Recovery Paths

| Layer | Trigger | One-shot scope | Conflicts? |
|-------|---------|---------------|------------|
| `verifyInjection` | 1.5s after every `rawInject` | per-injection | independent — different timer, different captureOutput call |
| `pasteRetried` set (idle-detection) | `[Pasted text #N]` visible at idle prompt | per-session lifetime | independent — distinct match string |
| StallTriage fast-path | text at `❯` with no glyphs, before LLM | per-triage-pass | independent — runs from triage scheduler, not injection |
| Existing zombie-kill timer | idleMs > IDLE_PROMPT_KILL_MINUTES | global | unchanged — only fires if all 3 above missed and the session sat for full timeout |

The four layers gate from "fast and proactive" to "slow and destructive."
Adding the new two layers above the existing two is monotonically safer.

## Rollback Cost

- Revert: drop `this.verifyInjection(...)` call in `rawInject` and the
  `verifyInjection` method body. Drop the fast-path block in
  `StallTriageNurse`. Pure additive — no schema, no state, no migration.
- Both changes have dedicated unit tests; removing them removes the tests.
- Branch surface area: 2 source files touched, 2 test files added.

## Evidence

- `tests/unit/session-injection-verify.test.ts` — 7 tests covering marker
  extraction, the captureOutput call, the Enter resend, and the no-op when
  the text already submitted.
- `tests/unit/stall-triage-typed-not-submitted.test.ts` — 5 tests covering
  detection thresholds, glyph-presence refusal, and the LLM-bypass path.
- Live reproduction: Justin's 2026-05-11 screenshot on Claude Code v2.1.139
  shows the failure mode this fix targets.
