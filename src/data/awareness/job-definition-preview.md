---
title: Private job definition preview
---
For a question about job migration in an enrolled disposable development agent, open Jobs and choose **Preview job migration** after the owner unlocks the console. The existing `GET /jobs/reconcile?preview=job-definitions` route requires the current private operator session. A returned cursor continues the same snapshot. Restart the preview if the page says that snapshot changed.

The preview shows which local files were checked, verified loader selection or suppression where available, and unresolved candidates. It keeps scheduler state, ownership, future migration and other machines separate. It does not change a definition or run a job.
