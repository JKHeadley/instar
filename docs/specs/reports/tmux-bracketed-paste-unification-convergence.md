# Convergence Report — Tmux Injection Unification

## ELI16 Overview

When a session pauses for compaction (or starts fresh), instar drops a
short "here's what we were doing" note into the agent's input box and
hits Enter for the agent. Today there's a quiet bug: for short notes,
the Enter keystroke gets eaten by Claude Code's input handler before
the text is finished being typed in. The agent sees the note sitting in
its input box but never receives it as a "submit." The session sits
silent until somebody manually presses Enter.

This spec rewrites that delivery step. Instead of "type characters then
hit Enter immediately," we use a tiny protocol that terminals understand
called "bracketed paste" — basically wrapping the text in invisible
markers that say "this is one paste, treat it as a whole." Then we wait
half a second for the terminal to settle before pressing Enter. This
matches what we already do for long multi-line messages (where it has
worked reliably).

After we press Enter, a background check fires 1.5 seconds later and
peeks at the agent's screen to confirm the message actually went in. If
the text is still sitting in the input box, it presses Enter once more
(a second peek confirms). If it's STILL stuck after two retries, we log
a critical error so the recovery reaper (the other thing we're shipping)
can pick it up at the 3-minute mark.

What this means for users: messages that today silently disappear into
the void during a session pause will now actually reach the agent. The
trade-off is a small added delay on every message (about half a second)
to give the terminal time to process the text properly. The added delay
is below human perception for chat-style use.

## Original vs Converged

The original spec was a two-line fix: use bracketed paste for all
messages, add a verifier that retries Enter if stuck. Five review
rounds caught a series of subtle bugs that would have re-created the
original failure mode in narrow cases or introduced new ones:

- **Security**: the original sanitization only stripped two specific
  byte sequences. Reviewers found that 8-bit C1 control characters and
  UTF-8-encoded C1 characters could escape paste mode equivalently.
  Sanitization broadened to the full C0/C1 control range.

- **Concurrency**: the original verifier had no way to tell whether the
  prompt on screen now belongs to the message it's verifying or to a
  newer message that arrived in between. A per-session sequence number
  plus an incarnation token (tied to tmux's session creation timestamp)
  was added so the verifier always knows whether to act or stand down.

- **TUI fragility**: the original assumed `tmux capture-pane` returns a
  small window of screen content. The external GPT reviewer pointed out
  that without explicit flags, it could return MB of scrollback and
  block the event loop. Bounded to 30 lines of visible+scrollback.

- **Process explosion**: external Gemini reviewer pointed out that
  every message now spawns 3-5 tmux child processes. At current load
  (~5-10/min) this is fine; at Phase 3 scale (500+ concurrent sessions)
  it would hit OS process limits. Captured as a follow-up to address
  before that scale becomes real.

- **Silent bug**: a method called `injectTelegramMessage` returned
  `value !== false`. After the async conversion, `value` becomes a
  Promise — which is never `=== false`. The method would silently
  always return `true` regardless of actual success. Caught by round 2
  integration reviewer; the explicit `(await value) !== false` fix
  shipped.

- **TUI prompt rendering**: the original looked for the literal `❯ `
  prompt sigil. External reviewers pointed out Claude Code uses styled
  prompts like `╭─❯` and that the sigil could change in any future
  release. Two changes: (a) match a broader anchored regex; (b) move
  the regex into config so an operator can hot-fix without a code
  deploy if the TUI changes.

- **User-facing alert**: the round 2 draft proposed posting a Telegram
  warning when a stuck submit can't be recovered. Integration reviewer
  flagged that SessionManager has no wiring to the Telegram adapter —
  threading a callback through would be a 3-file change. Scope-cut:
  the critical degradation event fires; the recovery reaper (separate
  spec, already approved) is the cross-cutting user-facing path.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1         | all 4 internal       | 28                | Async conversion, sanitization, seq guard, two-sample verifier, suffix-length minimum, wrap-walking, test inventory, retry rate-limit |
| 2         | all 4 internal       | 14                | Broaden sanitization to all C1, scope-cut Telegram alert, seq+incarnation, anchored regex, ANSI strip, fire-and-forget `.catch` mandate, exhaustive call-site table, `injectTelegramMessage` silent-bug fix |
| 3         | all 4 internal       | 9                 | Seq-check ordering at every capture stage, incarnation token, observability counters for skip classes, threshold-on-sanitized-text, broader test-file audit |
| 4         | all 4 internal       | 0                 | Convergence confirmed |
| 5 (cross-model) | GPT, Gemini, Grok | 11 (5 mat) | Capture-pane bounds, bracketed-paste fallback detection, no-sigil-inconclusive, incarnation fetch failure, bounded-risk language, sigil regex into config, credential redaction in previews |

## Full Findings Catalog

See Appendices A (round 1), B (round 2), C (round 3), D (round 5
cross-model) in the spec file itself for the structured catalog. Each
finding records: reviewer perspective, severity, original text, and
resolution path.

## Convergence verdict

**Converged at iteration 5 (1 internal-only round + 1 external
cross-model round after all internal reviewers concurred).** No material
findings remain unaddressed. Two architectural improvements
(p-limit-style concurrency throttle for tmux subprocesses; node-pty
migration) are explicitly deferred with documented follow-up tracking
in §4.7 — both are Phase 3 scale concerns that do not affect current
load envelope.

The spec is ready for user review and approval.
