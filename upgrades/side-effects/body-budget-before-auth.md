# Side effects: body size decided before the body is read (SEC-103)

## What changes for running agents
- Callers with the agent token, a valid dashboard (`dst_`) or memory (`mps_`) session, a signed paired device, or a signed paired machine on a machine route: no change. They keep the 12 MB general limit, 32 MB on `/mobile/org/recover` and 2 MB on `/hooks/post-compact`.
- Public peer routes (mesh RPC, a2a inbox, relay, Threadline peer routes, project-app api, WhatsApp webhook) drop from 12 MB to 2 MB for callers who carry no bearer. Threadline caps inbound payloads at 64 KB itself, and Telegram-sized messages are a few KB, so no known legitimate payload comes near 2 MB. An oversized peer body now gets 413 `body-too-large` instead of being parsed.
- Everyone else (no credential): 64 KB. Every pre-auth route that takes a body without a bearer was checked and carries small bodies: PIN unlock, console ticket, recommended-services confirm and code, Secret Drop submit, document page writes, `/api/pair`, identity reannounce, OIDC worktree check.
- Malformed JSON is now a 400 `invalid-json` and an oversized body a 413, both with at most one log line per code per minute. Before, each was a 500 with a full stack trace logged per request. Clients that only check `ok` behave the same; anything that relied on a 500 for bad JSON now sees 400.
- Each request with a body and a device or machine id header costs at most one registry lookup per id per second (a 1 s memo).

## Signal vs authority
This is admission sizing, not authentication. A device or machine id plus the presence of its signature headers only decides how much may be read. The real device signature and machine signature checks still run on the body, and the auth gate is unchanged. A wrong guess here can only cost a legitimate caller its large budget, never grant access.

## Residual (not closed here)
- Machine ids are not secret: every machine names itself in device 401s. Someone who learns a sibling machine's id and sends the machine header set with a fresh timestamp can still get up to 12 MB parsed on an `/api/*` path before the signature check refuses it. Closing this needs either an exact machine-route list or per-route machine limits.
- The 413 for a declared oversized body carries no CORS headers (CORS is mounted after the parser). Only strangers reach it.
- `/messages/relay-machine` is machine-authed but sits outside `/api/`, so it gets the 2 MB peer budget, not 12 MB.

## Rollback
Revert the commit. No stored data or config changes.

## Second-pass review
**Reviewer:** independent second-pass subagent (fresh context, read-only, two rounds).
Round 1 blocked on two findings, both accepted and fixed. First, a path-only public-route allowlist gave strangers 12 MB on `/secrets/drop/*`, the document page and the peer routes. Second, device and machine ids alone (this machine's own id is handed out in 401s) unlocked the full budget. It also flagged three further problems, all fixed: chunked bodies were still drained, the new log line could include a URL token, and each spoofed id cost a file read. Round 2 said nothing blocks. Its non-blocking notes were acted on: the 411 for bodies with no declared length was replaced by a bounded read plus 413, so tunnel behaviour around Content-Length cannot lock out PIN unlock, and the peer tier was widened from 1 MB to 2 MB for mesh headroom. One note is recorded as a residual above: a sibling machine's id still unlocks 12 MB on `/api/*`.
