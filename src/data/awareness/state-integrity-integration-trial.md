---
title: State Integrity Startup Trial
---
The optional `jobs.stateIntegrityProjectIntegrationTrial` setting accepts `baseline` to measure the ordinary launch or `without-project` to measure a supported Claude launch with no project integrations. It starts disabled. Authenticated `GET /jobs/state-integrity-check/history` shows the variant and any first recorded startup usage. Existing orphan checks and repair rules still apply.
