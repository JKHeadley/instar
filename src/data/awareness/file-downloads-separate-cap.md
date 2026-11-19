---
title: Large file downloads and file links
---
Files too big to preview (over the viewer's preview limit, 1 MB by default) can still be downloaded: downloads have their own limit, 1 GB by default (`dashboard.fileViewer.maxDownloadSize`), and the console's Files page shows a Download button for them. When you send someone a link to a file, mint it with `curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/api/files/link?path=PATH"`: its `relative` field opens the file on the new console's Files page (`/dashboard/console/#/settings/files?path=...`), not the legacy dashboard.
