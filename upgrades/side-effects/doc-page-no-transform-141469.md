# Side-Effects Review — the document page is served exactly as instar sends it

**Version / slug:** `doc-page-no-transform-141469`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, messaging or session-lifecycle surface)`
**Tier:** 1 (1 source line + 1 test assertion; reversible by revert). Effort: 0 spec rounds, first commit attempt.

## Summary of the change

The real-tunnel run of the Instar Documents proof (topic 141469) found Cloudflare Web Analytics auto-injecting `static.cloudflareinsights.com/beacon.min.js` into the HTML shell at `GET /docs/:id`. `DOC_PAGE_CSP` (`script-src 'self'`) blocked it, but every open logged a CSP violation, and the spec's guarantee (§8, "the page adds no new risk ... `script-src 'self'` serving only instar's own files") should not depend on the CSP catching a third-party edit. The shell now sends `Cache-Control: no-store, no-transform`, which Cloudflare documents as disabling automatic beacon injection (and Polish, compression and JavaScript Detections) for that response.

## Decision-point inventory

None. A response header; nothing is blocked or allowed.

## 1. Over-block

Nothing is rejected. Cloudflare compression is off for the shell only (a few KB of static HTML). Assets, `page-data` and `page-compare` are unchanged and still compressed.

## 2. Under-block

Cloudflare community reports say Pages sometimes ignores `no-transform`. These tunnels are not Pages, but the post-release check (a browser run over the tunnel with zero CSP violations) confirms it. If injection persisted, the CSP still blocks the script, as it does today, and the zone's Web Analytics setting is the remaining lever.

## 3. Level-of-abstraction fit

The page route owns its own headers (`pageHeaders`). Adding the directive there is the narrowest fix; a zone-wide Cloudflare setting would be outside instar and per account.

## 4. Signal vs authority compliance

No authority added (docs/signal-vs-authority.md).

## 5. Interactions

`pageHeaders()` sets `no-store` first; the shell route overrides it with `no-store, no-transform`, so caching behaviour is identical. The console and dashboard routes are untouched (the dashboard was not being injected).

## 6. External surfaces

One response header on one HTML route. Intermediaries that honour `no-transform` will not recompress or rewrite the page.

## 7. Multi-machine posture

Machine-local, stateless: every machine serving the page sends the same header.

## 8. Rollback cost

Revert the commit. No state.

## Evidence

See `upgrades/next/doc-page-no-transform-141469.md`.
