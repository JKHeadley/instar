---
title: Failed Verification Evidence
---
A failed Local Verify run keeps `.local-verify-failures.json` inside its retained checkout under `.worktrees/.verify/runs/<head-prefix>/`. Read this diagnostic to compare the actual assertion before calling a failure unrelated or retrying unchanged code. It contains bounded test names and error text, plus unit process diagnostics when the runner exits unsuccessfully without naming a failed test; `truncated: true` discloses omitted evidence. Normal retention keeps three failed checkouts. A write failure is logged and never changes the verification verdict.

