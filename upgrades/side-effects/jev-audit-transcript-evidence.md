# Side-Effects Review — Jev audit: transcript evidence for model-session jobs

**Version / slug:** `jev-audit-transcript-evidence`
**Date:** `2026-09-24`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; observe-only input to an observe-only audit; no decision surface added)`

## Summary of the change

The Jev job-completion audit captured a model-session job's output from its
tmux pane at `sessionComplete`, when the pane is already gone. Measured on the
originating agent (2026-09-24): of 572 pending evidence packs, the ~440 from
model-session jobs were almost all blank (e.g. health-check: 319 empty, 6
non-empty), so the model was asked "did this job do what it promised?" with
only the description and the word "success". Script jobs were unaffected.

New `src/scheduler/jobTranscriptEvidence.ts` locates the job's Claude Code
transcript by its session UUID (default home plus every `~/.claude-*`
subscription-pool config home, since the pane's `CLAUDE_CONFIG_DIR` is no
longer readable), reads a bounded tail (1 MB), and renders a compact trace:
one line per command, its clamped result (500 chars, `(error)` marked), and
the final reply. `EFFECT: <path>` claim lines are re-emitted verbatim, but only
from the job's own words (assistant text or an `echo`/`printf` step), never
from a file the job merely read. `JobScheduler.notifyJobComplete` hands this to
`jevAudit.capture` only; job state, run history and notifications keep the
pane capture exactly as before. Any failure yields '' and the pane capture is
used.

Smoke-tested against the 16 most recent real job sessions on this machine:
16/16 transcripts found, evidence 1.4–7.6 KB (within the audit's 8 KB tail).

## Decision-point inventory

- *(none)* — the audit remains observe-only; this only changes what text its
  existing capture receives.

---

## 1. Over-block

Nothing is rejected anywhere. The only consumer is the observe-only audit.
The audit's `trivialHeuristic` baseline now sees real text, so fewer silent
runs are labelled `suspicious` by that baseline; that is the correct direction
(an empty output was never evidence of failure for a job told to be silent).

## 2. Under-block

Non-claude-code frameworks (codex, gemini, pi, grok) still get the pane
capture; their transcripts have different formats. Their share of job runs on
this agent is zero today. If a transcript is absent (e.g. an unusual config
home outside `~/.claude-*`), the run falls back to the pane capture — today's
behaviour.

## 3. Level-of-abstraction fit

The transcript read happens at the single scheduler completion site that
already builds the audit input. Reading is kept out of the audit class so the
audit's contract (text in, scrubbed + clamped pack out) is unchanged; its
existing scrubbing (`scrubForStore`) and 8 KB tail clamp apply to the new text
unchanged.

## 4. Signal vs authority compliance

Signal only. The trace is evidence text for a model that has no authority
(the audit decides nothing: no block, alert, retry). The EFFECT-claim filter
is deliberately conservative: a spurious claim can only cause a declared file
to be verified, never widen the verified set (the audit already ignores
undeclared claims).

## 5. Interactions

- Transcript read is synchronous but bounded (≤1 MB, one stat per `~/.claude-*`
  dir) and runs only when the audit is wired, only for claude-code jobs with a
  `claudeSessionId`.
- The audit's existing "capture must never break completion" try/catch wraps
  the new code too.
- Conditional-effect claims printed by `reflection-trigger` /
  `commitment-detection` were also lost with the pane; they now reach the
  parser, so those jobs' deterministic column becomes live as intended by the
  previous change.

## 6. External surfaces

The evidence sent to the Jev service (only while an operator-enabled soak is
running) now contains command lines and clamped command results in addition
to the final reply. All of it passes the audit's existing secret scrubber
before storage or egress, the same path the pane text already took; the
operator consented to scrubbed job output leaving the machine when enabling
the soak. No new user-facing message, no new route.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the transcript lives on the machine that ran the job,
and evidence packs are machine-local and never replicated (unchanged).

## 8. Rollback cost

Revert the one call site in `notifyJobComplete`; the audit returns to pane
capture. No state, migration or config involved.
