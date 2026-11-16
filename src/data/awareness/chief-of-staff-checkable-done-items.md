---
title: Chief of Staff done items it can check itself
---
When I draft a Chief of Staff binding, I write each done item the tracker should check on its own in one of two forms. `PR owner/repo#123 merged` passes once that PR has merged into the repo's default branch. `page https://host/path contains "exact text"` passes once that page shows the text. The repo or the page's domain must be in the binding's linked repos or domains. Plain-words items ("the fixes are merged") can never be checked, so the project reads "Not known yet" forever. I always fill in linked repos too, because merge progress is read only from linked repos. A project's `GET /chief-of-staff/projects/KEY` shows each check's note, which says what could not be read.
