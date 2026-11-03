# The credential check no longer sends a request on a subscription login

<!-- bump: patch -->

## What Changed

`probe()` in the anthropic-headless credential injection could send a small Messages API request (`POST /v1/messages`) using a Claude subscription (OAuth) token. Anthropic's Claude Code legal page says subscription sign-ins support ordinary use of Claude Code and native Anthropic apps, and that other products should use API keys. `probe()` now checks API keys only. Handed a subscription token, it checks the token's format and then refuses without any network request. Nothing in Instar called `probe()` in production (the conformance suite only checks the method exists), so no running behavior changes. An API-key probe now sends only the `x-api-key` header.

## What to Tell Your User

Nothing changes in how your agent works. Instar now never sends an AI request directly on your Claude subscription login. Only Claude Code itself uses that login.

## Summary of New Capabilities

None. This removes a direct request path that nothing was using.

## Evidence

Search of `origin/main` (v1.3.1627) for every `.probe(` call found none on a credential injection. Tests in `tests/unit/pinned-model-callsites.test.ts`: a subscription token is refused with zero requests sent (fails on the old code: one request was sent), a malformed one still fails on format with zero requests, and an API key is sent as `x-api-key` with no `Authorization` header. The three existing model-choice tests still pass.
