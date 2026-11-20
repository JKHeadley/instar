# Approval and one-time link pages cannot be framed, cached or leaked by referrer

<!-- bump: patch -->

## What Changed

SEC-124. The pages that open without the agent's bearer because the link is the permission (the MCP tool-change approval page, the memory-privacy repair link and Secret Drop) now send the same browser protections as the dashboard: no framing by other sites (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), no caching, and no referrer. Before, the approval page, which asks for the dashboard PIN, sent none of these, so a leaked link could be click-jacked. The pages look and behave the same.

## What to Tell Your User

- **Approval links are harder to trick you with**: "The pages where you approve a tool change or use a one-time link can no longer be hidden inside another website, and your browser won't keep a copy."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Anti-framing and no-cache on approval and one-time link pages | Automatic |

## Evidence

- `tests/unit/sec-124-preauth-page-headers.test.ts`: GET and POST (including a 404) on the approval page, the memory-privacy repair page and Secret Drop all carry the headers, also with mixed-case paths; the CSP does not restrict scripts; `/mcp/approve` (exact) and `/health` are untouched.
