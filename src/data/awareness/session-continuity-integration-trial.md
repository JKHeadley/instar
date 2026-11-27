---
title: Session Continuity Startup Trial
---
The optional `jobs.sessionContinuityProjectIntegrationTrial` setting accepts `baseline` to record startup on the ordinary launch or `without-project` to compare a supported Claude launch with an empty project integration list. It starts disabled. Authenticated `GET /jobs/session-continuity-check/history` shows the variant and any first-request usage attributed to the run.
