---
title: Script Job Result Records
description: A durable record for every production script result, with independent history checks and visible unchecked outcomes.
---

Every production script job now writes a result record before it runs and
fills in the outcome before it releases the job claim. The independent job
history lets Instar find a missing or unfinished record after a restart. A job
with a damaged result record stops using its script route and raises attention.
The job report shows which results are unchecked or still need investigation.

The Jev result judgment and outage replacement are being tested. Their
decision gates are off, so the record does not yet mean a model has reviewed
the result. Internal failure canaries have a separate durable assertion log.

The implementation has six parts:

- `JobSupervisionStore` registers attempts, records outcomes, and keeps model
  call history and review grades.
- `JobSupervisionEvidence` selects bounded, scrubbed facts that a future model
  may inspect.
- `JobSupervisionRollout` keeps model decisions off until the benchmark and
  rollout gates are deliberately opened.
- `JobSupervisionWorker` is the gated Jev and outage-replacement consumer.
- `JobFixedResultCertificate` checks signed evidence before a known exact
  result can be closed by a fixed rule.
- `JobSupervisionReplacementPrompt` defines the bounded replacement judgment
  request and validates its answer.

The approved design and measurement requirements are in
`docs/specs/job-result-supervision-v2.md`.
