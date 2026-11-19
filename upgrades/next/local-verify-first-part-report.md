# First-part trials use observations and findings

<!-- bump: patch -->

## What Changed

Local Verify no longer runs a second full comparison after a verify. Each run machine records its verifies and exposes `/local-verify/first-part-report`, including file suspects, confirmed red-main episodes on the coordinator, findings and daily cost measurements. Old comparison state no longer overrides the configured setting.

## What to Tell Your User

Read each machine's report during a trial. The operating session records a finding within three days using `/local-verify/first-part-finding`. Unknown findings remain unresolved. The two cost limits require two daily evaluations with new observations before switching that machine off; a config write failure is reported and retried at the next daily evaluation.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Read and evaluate suspects | GET `/local-verify/first-part-report?evaluate=1` |
| Mark the joint trial's start | POST `/local-verify/first-part-report/new-trial` |
| Record an investigation | POST `/local-verify/first-part-finding` with suspect, finding and reason |

All three routes are available on peers. Existing agents receive the rewritten awareness entry automatically on update.
