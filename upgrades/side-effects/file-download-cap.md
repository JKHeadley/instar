# Side-Effects Review — separate file download cap, Download button for too-large files, console file links

**Version / slug:** `file-download-cap`
**Date:** `2026-11-17`
**Author:** `echo (echo-instar-desktop-app)`
**Second-pass reviewer:** `not required`

## Summary of the change

`GET /api/files/download` refused any file over `fileViewer.maxFileSize` (1 MB, the preview cap), so a file too big to preview could not be downloaded at all (commitment CMT-1819, feedback fb-8016096b-dd1). This adds `fileViewer.maxDownloadSize` (default 1 GB, optional, never below `maxFileSize`) used only by the download route; `GET /api/files/config` reports it. The console's Files page shows a Download button on the "too large to open here" card, and its 413 texts say which limit applies. `GET /api/files/link` now returns the new console's Files deep link (`/dashboard/console/#/settings/files?path=`) instead of the legacy `/dashboard?tab=files&path=`. One awareness entry tells agents. Files: `src/server/fileRoutes.ts`, `src/core/types.ts`, `dashboard/console/files.js`, `dashboard/console/files-model.js`, `src/data/awareness/file-downloads-separate-cap.md`, tests.

## Decision-point inventory

- `GET /api/files/download` size check — modify — the size ceiling is now the download cap instead of the preview cap. Every other admission check (path validation, never-served, blocked filenames, checked-descriptor open) is unchanged and still runs first.

---

## 1. Over-block

No new block. Files between 1 MB and 1 GB that were refused are now served. A file over 1 GB is still refused with 413 naming the download limit.

---

## 2. Under-block

The size check is the only thing relaxed; it is not a security control (key material, secrets, paths outside the allowed folders are refused before it, unchanged). A larger cap means a bigger response can be pulled by an authenticated caller; the route streams from the checked file descriptor, so memory use on the server does not grow with file size. The console fetches the blob into browser memory; a 1 GB download in a phone browser could be slow or fail, which is the browser's limit, not a server risk.

---

## 3. Level-of-abstraction fit

Right layer: the cap lives in the same file-viewer config as the preview and edit caps and is enforced in the one download route.

---

## 4. Signal vs authority compliance

No change to authority: the route keeps the same admission chain; only a numeric ceiling changes. Not a judgment point.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point added; a configured size ceiling is a floor, not a heuristic.

---

## 5. Interactions

The image preview route keeps `min(IMAGE_PREVIEW_MAX, maxFileSize)`. Read keeps `maxFileSize`. Save keeps `maxEditableFileSize`. The Studio workaround (a raised `maxFileSize`) keeps working because the download cap is never lower than `maxFileSize`.

---

## 6. External surfaces

`GET /api/files/config` gains `maxDownloadSize`. `GET /api/files/link` `relative` changes form; callers that open it get the new console Files page, which also still parses the legacy query. Agents learn it from the awareness entry.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The Files page's too-large card now carries a primary Download button, the same button and status line binary files already use, so a phone user can get the file in one tap; the card text says "You can still download it." A download over the download limit says so in words with both sizes.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the file viewer serves this machine's project files; each machine applies its own config. No replicated state. Status surfaces: `GET /api/files/config` only.

---

## 8. Rollback cost

Revert the commit; no state, migration or data written. An operator can also set `maxDownloadSize` equal to `maxFileSize` to restore the old behavior without a release.

## Conclusion

Small, reversible, one numeric ceiling plus UI and link wording. Tier 1.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging decision touched.

## Evidence pointers

`tests/unit/fileRoutes-download-cap.test.ts` (read refuses 2 MB, download serves all bytes; over-cap 413 names the cap; cap never below preview cap; config reports 1 GB), `tests/unit/console-files.test.ts`, link expectations in `tests/unit/fileRoutes-link-allowed-paths.test.ts`, `tests/unit/fileRoutes-never-served.test.ts`, `tests/e2e/file-viewer-e2e.test.ts`.
