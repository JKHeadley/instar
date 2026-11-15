# Full read of the scope-cut spec (the interim path after the final read found 5 design issues) (sha256 78415d96…), with source access

You are doing a full, independent review of the final text of an instar spec before it goes to the owner for approval. Earlier rounds reviewed earlier versions without source code, and edits were made after the last round. This read closes that gap.

- Spec: /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/spec-cut-frozen.md (identical to docs/specs/job-launch-intent-record.md in your working directory)
- History: round1-triage.md and round2-triage.md in docs/specs/reports/job-launch-intent-record-rounds/; the report is docs/specs/reports/job-launch-intent-record-convergence.md
- Source: your working directory is the instar worktree. **Verify the spec's code claims against the actual code.** Start with src/core/frameworkSessionLaunch.ts, src/core/SessionManager.ts, src/scheduler/JobScheduler.ts (spawn ~2900-3180, completion ~3540), src/scheduler/JobRunHistory.ts, src/scheduler/AgentMdJobLoader.ts, src/scheduler/JobLoader.ts, src/core/ClaudeBinaryRetainer.ts and src/core/topicProfileValidation.ts.

Check in particular:
- the four invariant rows' basis/evidence, and whether each is truly invariant;
- the round-3 additions: day-alternating arms, the 1-hour TTL, the `truncated` field, the script-computed floor verdict, and `recordLaunchVersion`;
- whether any code claim is false.

Tag each finding DESIGN (changes what gets built) or PRECISION. End with one line: VERDICT: CONVERGED (no DESIGN findings) or VERDICT: NOT CONVERGED. Keep it to 500 words, no preamble. Do not edit files.

Context for this read: the previous full read (final-read-gpt-6-astra.md and final-read-fable-5-2.md in the same folder) found five DESIGN issues. The response was a scope cut: the benefit experiment moved to a separate pilot spec, leaving only the mechanism and its record. Fixes were also made for the retainer null cache, the row-size cap, and the call sites and capture points. Check those fixes, then do a full read as before.
