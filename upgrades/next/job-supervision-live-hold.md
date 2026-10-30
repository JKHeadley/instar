# Scheduled-result hold after startup

## What Changed

A running scheduler now checks its durable supervision hold before each script admission, including after an asynchronous gate. A certificate revocation or other hold written after scheduler startup therefore closes the next script route without requiring a restart. A joined test-agent lifecycle test exercises mocked provider decisions, timeout, a late answer, planted-secret redaction, a synthetic certificate revocation hold, and a hold arriving during the gate.

## Evidence

See `docs/specs/job-result-supervision-v2-joined-test-agent-evidence.md`. The live provider, pool certificate registry, and development shadow gates remain open. Production model decisions remain off.

## What to Tell Your User

The running scheduler now notices a newly recorded safety hold before it starts another script. The test agent uses synthetic results and mocked model replies, so this is safety evidence, not permission to turn on production decisions.

## Summary of New Capabilities

Durable supervision holds take effect on the running scheduler's next script admission. The joined lifecycle test checks the scheduler and server path under synthetic inputs and records exactly which rollout gates it does and does not cover.
