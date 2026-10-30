# Review feedback design drafts as designs

## What Changed

The feedback executor now tells its independent safety reviewers whether a PR contains an implemented fix or a design draft. A design draft is reviewed for safe scope and a concrete regression-test plan only while its current head is exactly the expected newly added draft file. The fix path continues to require an executable test that would fail without the change.

## Why

Live evidence: executor-produced PR #2439 was a one-file design draft, but its reviewer rejected it solely because it had no implementation or executable test. The corrected prompt distinguishes that expected design stage from a code fix. The review verdict gate, two-family requirement, protected-path rule, and exact-head merge requirement are unchanged.
