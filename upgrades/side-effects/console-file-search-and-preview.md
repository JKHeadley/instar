# Side-Effects Review — whole-project file search and image preview on Files

**Version / slug:** `console-file-search-and-preview`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two read-only file-viewer routes and their use on the console Files page. `GET /api/files/search?q=&limit=` (`src/server/fileRoutes.ts`, `searchByName`) does a breadth-first name match over the viewer's allowed folders: every entry is admitted by the existing `resolveListEntry` (never-served and blocked names on the requested AND resolved path, realpath inside the project) plus the shared allowed-path pre-check on both spellings, and every match is re-checked with `validatePath` before it is returned. Real directories are visited once (a symlink loop cannot recurse), `.git` and `node_modules` are never descended, and the walk is bounded (200 results max, 20,000 entries, depth 12, 2 seconds; `truncated: true` when it stopped early; q at most 200 characters). `GET /api/files/image?path=` serves an image for preview through the same admission as download (validatePath, blocked names on both spellings, the checked-descriptor open that defeats symlink swaps and hard links to key files), reads the real type from the first bytes (PNG, JPEG, GIF, WebP only; SVG and a renamed file are 415), caps the size at min(5 MB, the viewer's `maxFileSize`) with 413, and answers inline with the sniffed Content-Type, `nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`. The Files page searches the whole project as you type (debounced, with the opened-folders search as the fallback for an older server) and previews an image through a `blob:` URL (the console CSP already allows `img-src 'self' blob:`). Agent awareness: one CLAUDE.md template line plus a content-sniffed `migrateClaudeMd` bullet. Redoes the search and preview pieces of closed PR 2377; its client-side byte sniff over the download route is replaced by the server-side typed route.

## Decision-point inventory

- File viewer admission (`validatePath`, `resolveListEntry`, `checkBlockedFilename`, `openCheckedDescriptor`) — pass-through — reused unchanged by both new routes; no rule is loosened.
- Image type gate (`sniffImageType`) — add — a deterministic allow-list of four raster magic numbers on a read-only preview route.

---

## 1. Over-block

An image larger than the viewer's `maxFileSize` (1 MB by default) is not previewed; the page says so and offers Download, which has the same limit today. A BMP, TIFF, HEIC or SVG is not previewed (shown as "not previewed here; download it"). A search on a very large project can stop at the 20,000-entry or 2-second cap before reaching a deep match; the page says the list was cut and to type more of the name.

---

## 2. Under-block

The search only matches names; it never reads contents, so a secret inside an innocently named file is as visible as it already is through read. A file added to the never-served list later is covered automatically because the walk uses the same functions.

---

## 3. Level-of-abstraction fit

Right layer: both routes live in `fileRoutes.ts` beside list/read/download and reuse their admission functions rather than re-implementing any rule. The image type check moved to the server so the browser never decides what is an image.

---

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a deterministic safety floor on a read-only path, not a judgment call.

The only new gate is the four-type magic-number allow-list on what the preview route will serve inline. That is a security floor (do not serve markup or unknown bytes as an image), enumerable by design, and refusal only means "download it instead". No message, session or agent action is gated.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point. The image allow-list is an enumerable invariant (file signatures), and the search caps are resource bounds.

---

## 5. Interactions

Both routes sit behind the existing `/api/files` "viewer is off" guard (404) and the bearer auth middleware; a memory-boundary session token is refused by the default-deny `memorySessionGuard`. The console CSP for `/dashboard/console/` already allows `blob:` images, so no CSP change was needed. The search walk adds filesystem reads; it is bounded per request and the page debounces typing (250 ms) and drops stale answers.

---

## 6. External surfaces

Two new owner-only routes. The Files page now finds a file anywhere it is allowed to browse and shows pictures. Timing: the 2-second walk bound depends on disk speed; slow disks return fewer, truncated results, said honestly.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The search box stays at the top of Files; results replace the list as you type. An opened image shows the picture first, then the size line and Download.
2. **Zero raw internals as primary content?** Yes. Results show the file name with its folder; refusals are plain sentences ("This file is never shown, by design.").
3. **Destructive actions de-emphasized?** No destructive action added.
4. **Plain language + phone width?** The image is `max-width: 100%` and `max-height: 70vh`; no new wide element. Words: "Showing the first 50 matches; type more of the name to narrow it."

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Files are per machine; the Files page already says which machine it shows. Search and preview read only this machine's project folder, the same as list/read/download. No notices, no durable state, no generated URLs (the page uses the route path with its own bearer token). **Status surfaces:** none changed.

---

## 8. Rollback cost

Pure code change; revert and ship a patch. No state is written. On a rolled-back server the page gets 404 from search and falls back to the opened-folders search; the image preview then shows its "No preview" line with Download still working.

---

## Conclusion

Small and reversible, read-only, and built entirely on the viewer's existing admission rules. The review moved the image type decision from the browser to the server (old PR 2377 sniffed bytes client-side over the download route) so a renamed or SVG file is never served as an image at all. Clear to ship.

---

## Evidence pointers

- `tests/unit/console-file-search-preview.test.ts` — searchByName on a real tree (key file, secret name, link to a key, loop, caps), sniffImageType, page model, awareness, jsdom Files page search + preview.
- `tests/integration/file-search-image-routes.test.ts` — both routes through createFileRoutes + authMiddleware: 401/400, refusals, 415 for SVG and a renamed file, 413, headers.
- `tests/e2e/file-search-image-alive.test.ts` — both routes 200 on the AgentServer boot path.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
