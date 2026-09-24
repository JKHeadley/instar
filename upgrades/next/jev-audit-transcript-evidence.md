# Job-completion audit: model-session jobs give the audit real evidence

## What Changed

The Jev job-completion audit captured a model-session job's output from its
tmux pane after the pane had closed, so almost every such evidence pack had an
empty output (originating agent, 2026-09-24: health-check 319 empty of 325).
The audit now reads the job's Claude Code transcript (located by session UUID
under the default home or any `~/.claude-*` subscription-pool config home,
bounded 1 MB tail) and passes a compact trace — each command, its clamped
result with errors marked, and the final reply — to the audit's existing
scrubbed, clamped capture. `EFFECT:` claim lines are carried through only from
the job's own words (assistant text or an echo/printf step). Job state, run
history and notifications are unchanged; any failure falls back to the pane
capture.

## Evidence

`tests/unit/jobTranscriptEvidence.test.ts` — eleven tests: trace renders
commands, results and final reply last; failed steps are marked; huge results
are clamped; EFFECT claims survive from the reply and from an echo step but
not from a file that was only read; torn lines tolerated; transcript found
under a pool config home and the default home; non-UUID ids refused; read
failures yield empty. `tests/unit/JobScheduler-jev-transcript.test.ts` — four wiring tests through
the real `notifyJobComplete`: the transcript trace reaches the audit when found;
the pane capture is used when not; no lookup without a session id or for a
codex job. Related suites (`JevJobCompletionAudit`,
`jev-audit-wiring`, `JobScheduler`) green. Smoke test on 16 real job sessions:
16/16 transcripts found, 1.4–7.6 KB of evidence each.

## What to Tell Your User

If the scheduled-task checker trial is on, it can now actually see what each
task did. Before, most tasks reached it as a blank, so it could only answer
"can't tell". Nothing changes about how tasks run.

## Summary of New Capabilities

- The job-completion audit receives a transcript-derived trace for
  claude-code model-session jobs instead of an empty pane capture.
