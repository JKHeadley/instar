# Full read of the revised scope-cut spec (sha256 35d93280…), with source access

This is an independent full review of the final text before it goes to the owner. Your working directory is the instar worktree. Verify the spec's code claims against the code.

- Spec: /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/spec-cut3-frozen.md (identical to docs/specs/job-launch-intent-record.md here)
- The previous read and its findings: /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/cut-read-gpt-6-astra.md and /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/cut-read-fable-5-2.md. Its one DESIGN finding (Astra) was the built-in template generator. It was answered by naming the generator, the old dashboard editor and writeUserTemplate as paths deliberately not covered, with the reason for each (built-ins gain the field only through the pilot spec). Precision items were applied too.

Check whether those fixes hold, then do a full read. **Hunt specifically for any other place that hand-lists job definition fields**, because each earlier read found one more. Tag each finding DESIGN (it changes what gets built) or PRECISION. End with one line: VERDICT: CONVERGED (no DESIGN findings) or VERDICT: NOT CONVERGED. Keep it to 400 words, no preamble. Do not edit files.
