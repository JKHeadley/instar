# Side effects: pre-auth capability pages get anti-framing, no-store and no-referrer headers (SEC-124)

In plain words: the pages reachable without the bearer whose URL carries the capability (MCP approval `/mcp/approve/<id>`, memory-privacy repair `/memory-privacy/fix/<token>`, Secret Drop `/secrets/drop/<token>`) now get `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Pragma: no-cache` and `Referrer-Policy: no-referrer` from `dashboardSecurityHeaders`, the middleware that already does this for `/dashboard` and `/view`.

Tier 1. Size: 1 source file (about 20 lines), 1 new test file (5 cases). Effort: no spec rounds, first commit attempt.

## The defect
The MCP approval page asks for the dashboard PIN and has an Approve button, but sent none of these headers (the middleware only covered `/dashboard` and `/view`). A leaked approval link could be framed by another site with an overlay to obtain an Approve tap. The memory-privacy repair page had the same gap, and its one-time token could leave through a Referer. Secret Drop set framing and caching headers on its GET only.

## Over-block
These pages can no longer be shown inside a frame. Nothing in the dashboard, console or app frames them (checked: no iframe references to these paths). The CSP restricts only framing, `<base>` and form targets; the pages' inline script and style are untouched. The Secret Drop and approval forms submit with `fetch` to their own path, which `form-action 'self'` does not affect.

## Under-block
The agent-only `/mcp/approve` exact path is a JSON API and is deliberately untouched. Two residuals the second-pass review named, both low: a malformed or oversized POST body is answered by the body parser (mounted before this middleware) without these headers, but that answer is JSON with nothing secret; and a signed `/view/<id>?sig=` link keeps only the view sandbox CSP, with no `frame-ancestors` or `Referrer-Policy`. The sandbox already blocks script and forms there; it is listed with the other unnumbered sweep candidates reported to the Chief of Staff for numbering.

## Level of abstraction
One middleware already owns security headers for browser pages; this adds a prefix list to it instead of per-route header code. Paths compare case-insensitively, matching Express routing.

## Signal vs authority
Response headers only. Nothing is admitted or refused differently.

## Interactions
The Secret Drop route still sets its own `X-Frame-Options` etc.; the values match. The `/view` and `/dashboard` branches are unchanged.

## External surfaces
Browsers will refuse to frame these pages and will not cache them.

## Multi-machine posture
Machine-local by design: each machine's server sets headers on the pages it serves.

## Rollback
Revert the commit.

## Second-pass review
**Reviewer:** independent general-purpose reviewer subagent (read-only), given the diff and the three pages' code. It confirmed the middleware is mounted before the bearer gate and every route, so the pages' 404, 409, 410 and 503 answers carry the headers too; that none of the three pages has a `<base>` tag or a cross-origin form target, so the CSP breaks nothing; that nothing in this repo frames them; and it checked the whole bearer-skip list for missed pages (document pages already send `frame-ancestors 'none'`). It named the two residuals above. Concur with the review.
