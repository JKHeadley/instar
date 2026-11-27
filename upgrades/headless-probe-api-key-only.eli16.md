# ELI16: the credential check stops using subscription logins

## What this is

Instar can sign in to Claude two ways: an API key (paid per use, meant for programs) or a Claude subscription login (the same sign-in a person uses in Claude Code). Anthropic's Claude Code legal page says the subscription login is for ordinary use of Claude Code and Anthropic's own apps, and that other products should use API keys.

One small function, `probe()`, could check whether a credential works by sending a tiny AI request straight to Anthropic. It accepted both kinds of credential. Sending that request with a subscription login is exactly the kind of direct use the page points away from.

## What already exists

Nothing in Instar actually calls `probe()` today. A search of the current code found no caller; a test suite only checks that the function exists. So this was a path that could be used, not one that was used.

## What is new

`probe()` now only sends its request for an API key. For a subscription login it still checks that the token looks right, then says no without contacting Anthropic. The real check for a subscription login is Claude Code using it normally.

## Safeguards

A test proves a subscription login causes zero network requests, and that test fails on the old code. API-key checks work as before and send only the API-key header.

## What you need to decide

Nothing. Running behavior does not change, nobody has to sign in or manage anything, and a revert undoes it completely. This is one item from the account compliance review started 2026-11-03.
