# Feedback spec review shape: side effects

- The review prompt receives `kind` from the executor's stored `needsSpec` value, not from PR text or the untrusted report. The design rule is granted only when GitHub's current file list and diff show exactly one newly added expected draft path. A later push that adds code or changes that file shape is refused at that head with `spec-head-shape` and a PR comment.
- For a design draft, Rule 4 requires a concrete plan for regression tests that would fail without the future fix. It does not demand implementation or executable tests at the design stage. For a fix PR, Rule 4 retains its failing-test requirement.
- Scope, tooling, secret, injection, breakage, reviewer-family, CODEOWNERS, head-SHA, and merge gates remain. A reviewer can still reject an unsafe spec or a vague test plan.
- Existing PR #2439 has a recorded serious verdict on its current head. This change does not rewrite that verdict or automatically merge it; a new head or normal reviewer retry is required after deployment.
- Rollback restores the old shared prompt, which can again falsely reject a valid design-only PR.

## Independent second pass

An independent re-review of the current-head shape safeguard found no blocker after the malformed-head refusal was added. The reviewer checked that a valid newly added one-file draft can use the design prompt, while a later head that adds code or changes the draft shape is refused before review. This review does not approve any existing executor PR or waive its own head-specific gate.
