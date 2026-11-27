# Full read of the revised scope-cut spec (sha256 5ab6a46e…), with source access

This is an independent full review of the final text before it goes to the owner. Your working directory is the instar worktree. Verify the spec's code claims against the code.

- Spec: /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/spec-cut2-frozen.md (identical to docs/specs/job-launch-intent-record.md here)
- The previous read and its findings: /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/cut-read-gpt-6-astra.md and /Users/adriana/echo-compute/echo/docs/efforts/engine-optimization/step2/rounds/cut-read-fable-5-2.md. Its two DESIGN findings were the missed definition paths (jobMigrate.ts:164 and JobPortableBundle MANIFEST_KEYS). They were answered by naming both paths and adding a round-trip test across every path. Precision items were applied too.

Check whether those fixes hold, then do a full read. **Hunt specifically for any other place that hand-lists job definition fields**, because each earlier read found one more. Tag each finding DESIGN (it changes what gets built) or PRECISION. End with one line: VERDICT: CONVERGED (no DESIGN findings) or VERDICT: NOT CONVERGED. Keep it to 400 words, no preamble. Do not edit files.
