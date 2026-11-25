---
title: Memory Hygiene Startup Trial
---
The optional `jobs.memoryHygieneProjectIntegrationTrial` setting accepts `baseline` to record the normal start and `without-project` to measure Claude sessions started with an empty project integration list. It is disabled when omitted. The authenticated `GET /jobs/memory-hygiene/history` endpoint shows the variant and first recorded token event when the session has a bound transcript.
