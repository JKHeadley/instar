---
slug: ux-first-enforcement-inc1
review-convergence: true
approved: true
approved-by: Echo dispatch UX-First Enforcement Increment 1
parent-principle: "Live-User-Channel Proof Before Done"
---

# UX-First Enforcement Increment 1

This increment makes user-facing intent explicit on relevant pull requests and
adds three deterministic assertions to a real messaging E2E scenario. It does
not add `assertTimely`; injected-clock timing is Increment 2. The workflow runs
from the base ref, checks the PR body on open/synchronize/edit, and keeps
internal failures distinct from ordinary declaration violations.
