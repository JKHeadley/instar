# Side-Effects Review — dashboard scripts and styles are never stored

**Version / slug:** `dashboard-assets-no-store`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`dashboardCacheControl(res, filePath?)` in `src/server/middleware.ts` now stamps
`Cache-Control: no-store` on dashboard `.js`, `.mjs` and `.css` files and keeps `no-cache` on
everything else (pages, fonts, images). `DASHBOARD_STATIC_OPTIONS.setHeaders` passes the served
path, as serve-static already does. Three tests updated to the new contract.

Evidence (measured 2026-10-30 through the named tunnel `echo-studio.dawn-tunnel.dev`):
`no-cache` on HTML passes through (`cf-cache-status: DYNAMIC`), but on `.js/.css` Cloudflare
rewrote it to `max-age=14400` (`REVALIDATED`); `no-store` on the existing desktop assets passed
through (`BYPASS`). The operator's phone then kept a 4-hour-old `console.css` after release
1.3.1518 and the new maturation board rendered as unstyled grey blocks. #1441's premise that
Cloudflare honors `no-cache` for assets was wrong for this tunnel.

## Decision-point inventory

None — an HTTP header on static files; no gate, block or route decision.

## 1. Over-block
No block/allow surface.
## 2. Under-block
A browser that already holds a 4h copy keeps it until expiry; this fixes every later release.
Images/fonts still `no-cache` (they change rarely and are not module-coupled).
## 3. Level-of-abstraction fit
The single shared helper every dashboard static response already goes through.
## 4. Signal vs authority compliance
Not a decision point.
## 4b. Judgment-point check
None.
## 5. Interactions
The desktop route already sets `no-store` itself; unchanged. Pages keep ETag 304s.
## 6. External surfaces
Bandwidth: every dashboard load re-downloads its scripts and styles (a few hundred KB) over the
agent's own tunnel instead of a 304. Acceptable for a single-operator dashboard; correctness of
"a release reaches the screen" outweighs it.
## 6b. Operator-surface quality
Dashboard changes appear on the next load instead of up to 4 hours later.
## 7. Multi-machine posture
Machine-local by design is not needed: every machine serves the same header from the same code.
## 8. Rollback cost
Revert the helper; no persisted state.
## Conclusion
Small, reversible header change closing a measured stale-asset gap.
