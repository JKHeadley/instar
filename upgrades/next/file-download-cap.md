# Files too big to preview can be downloaded

<!-- bump: patch -->

## What Changed

The dashboard's file downloads used the same 1 MB limit as file previews, so any file over 1 MB could be neither shown nor downloaded. Downloads now have their own limit, `dashboard.fileViewer.maxDownloadSize`, 1 GB by default and never lower than the preview limit; `GET /api/files/config` reports it. On the new console's Files page, a file too big to show says "You can still download it" and has a Download button; a file over the download limit says so with both sizes. `GET /api/files/link` now returns a link to the new console's Files page (`/dashboard/console/#/settings/files?path=...`) instead of the legacy dashboard.

## What to Tell Your User

- **Downloading big files**: "Files too big to preview on the dashboard can now be downloaded, up to 1 GB, with a Download button right on the file. File links I send open the new dashboard."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Separate download limit (1 GB default) | Automatic; change `dashboard.fileViewer.maxDownloadSize` |
| Download button on files too big to preview | Console Files page |
| File links open the new console | `GET /api/files/link` |

## Evidence

Tests: `tests/unit/fileRoutes-download-cap.test.ts` (a 2 MB file: read 413, download returns every byte; over the cap 413 names the cap; cap never below the preview cap; config reports 1 GB), plus updated link and console text expectations in `tests/unit/console-files.test.ts`, `tests/unit/fileRoutes-link-allowed-paths.test.ts`, `tests/unit/fileRoutes-never-served.test.ts` and `tests/e2e/file-viewer-e2e.test.ts`. 37 + 65 targeted unit tests passed.
