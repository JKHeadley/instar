# The document page is served exactly as instar sends it

## What Changed

The Instar Documents page (`GET /docs/:id`, the HTML shell) now sends `Cache-Control: no-store, no-transform`. Driving the real page through a real named Cloudflare tunnel showed that Cloudflare's automatic Web Analytics was injecting its beacon script into the page. The page's strict Content Security Policy (`script-src 'self'`) blocked it, so nothing ran, but every open logged a CSP violation and the page was no longer the bytes instar served. Cloudflare's documentation says a `no-transform` directive stops that injection. Only the HTML shell carries it; the page's assets and JSON responses keep Cloudflare's compression.

## What to Tell Your User

None for most users: documents are switched on only for development agents. If they use documents: nothing visible changes; the page simply arrives without an analytics script added along the way.

## Summary of New Capabilities

None. This is a hardening fix to existing behaviour.

## Evidence

- Real tunnel, 2026-11-20 12:37 PST (echo-studio.dawn-tunnel.dev, browser user agent): the served page contained `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/...">`, and Chromium logged "violates the following Content Security Policy directive: script-src 'self'" at 1280×728 and 390×844. The same page fetched from the agent on loopback contained no such script.
- `tests/integration/documents-page.test.ts`: the shell's `cache-control` is asserted `no-store, no-transform`; 11/11 pass.
- After release, the check is the same browser run over the tunnel with zero console CSP violations.
