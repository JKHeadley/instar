---
title: Development Review Launch Observation
---
The optional `jobs.observeEmptyDevelopmentReview` setting records whether a shipped scheduled development review had an empty job roster. It starts disabled. Check the authenticated `GET /jobs/overseer-development/history` endpoint for `developmentReviewObservation`. A null `wouldSkip` means the roster was incomplete, and a null `actualUsage` means there is no attributed token usage yet. The review still launches on its normal schedule.
