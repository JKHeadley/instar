# Side effects: cut an oversized body at its limit; a device id opens the large budget only on device routes (SEC-118)

Tier 1. Size: 3 source files, 1 test file (8 new cases). Effort: one build pass, independent review.

## What changes for running agents
- A pre-auth upload without a declared length (chunked) that passes its parser's limit is answered 413 as soon as the limit is passed, and the connection is closed. Before, body-parser drained the whole stream first. This applies to the budget parser's small and peer tiers and to the fixed pre-auth parsers: completion-claim observe, the Threadline MCP endpoint, pairing-code redeem, local owner device, org check-in and pack propose, media uploads, and recommended-services keys.
- A declared Content-Length over a guarded parser's limit is refused before any byte is read, as the budget parser already did.
- Any 413 (and length-mismatch or aborted body) answered through the shared error handler now carries `Connection: close`.
- A paired device's narrowed admission (id, signature header and fresh time) unlocks the large budget only for a non-GET/HEAD method and path that match a device-allowlist rule that takes a body. Elsewhere it gets the small budget; the device authenticator refuses those requests anyway, so no legitimate device request loses its budget.
- Bodies of another content type pass the guards unread, so a later parser (for example a form-encoded webhook) still gets the whole body.

## Signal vs authority
Admission sizing only. Nothing here authenticates or grants. A wrong guess can only refuse an oversized body, never admit a request.

## Rollback
Revert the commit. No stored data or config changes.

## Not covered here
- A paired machine's narrowed admission (machine headers on `/api/*`) still unlocks 12 MB on any `/api/*` path. This is the SEC-103 residual and stays tracked.
- A gzip-encoded body is counted in raw bytes by the guard, while body-parser applies its own limit to the inflated size. Both limits still hold.
- Same class, outside the parsers (tracked as SEC-118-R1): a chunked body that no parser reads (no content type, or a non-matching type) on a route refused by the auth gate gets a 401 without `Connection: close`, so Node may drain it up to the server's request timeout.

## Second-pass review
**Reviewer:** independent read-only review subagent (fresh context, ran the unit file). Concurred with no blocking findings, after also checking the content-type pass-through, gzip, keep-alive and the device path normalization against `deviceAuthenticator`. Notes taken: GET/HEAD never count as body routes; the socket close is registered before the 413 (body-parser may resume the stream to drain it); the `/internal/` check uses the full path. Left as stated: the chunked test proves the 413 arrives before the upload ends, not who closed the socket. The drain outside the parsers is SEC-118-R1 above.
