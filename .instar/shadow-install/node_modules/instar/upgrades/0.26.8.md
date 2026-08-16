# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixed Slack file/snippet download reliability. Three root causes addressed:

1. **Auth header dropped on redirects**: Node.js `fetch` strips the `Authorization` header on cross-origin redirects (per spec). Slack's `url_private` URLs can redirect to CDN subdomains, causing the auth to be lost and an HTML login page returned instead of file content. FileHandler now follows redirects manually, preserving the auth header at each hop (capped at 5 redirects).

2. **Message attachments ignored**: Only `message.files[]` was processed. Link unfurls, rich previews, and integration content (Fathom transcripts, GitHub PRs, etc.) arrive in `message.attachments[]` and were silently dropped. Now extracted and inlined into message text.

3. **Silent error swallowing**: `files.info` API failures were caught and discarded with no logging. Now logs the actual error, making it possible to diagnose missing scopes or API issues.

Also prefers `url_private_download` over `url_private` when available — some file types have a dedicated download URL that works more reliably.

## What to Tell Your User

- **File and snippet sharing**: "Sharing files and snippets in Slack should work much more reliably now. Previously some attachments came through as blank or garbled HTML — that's been fixed. Link previews from external services like Fathom or GitHub are now included in the message too."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable snippet downloads | Automatic — auth header preserved across redirects |
| Link unfurl content | Automatic — attachment text extracted from unfurled links |
| Download error logging | Automatic — files.info failures now logged for debugging |
