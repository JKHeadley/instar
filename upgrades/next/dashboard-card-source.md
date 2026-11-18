# Work cards link back to their original message
<!-- bump: patch -->

## What Changed
Cards created from a message now show **From: Original message** in the console. The link opens the existing conversation reader and highlights the exact message. Older history can be searched in further batches, with failed or unavailable reads stated clearly.

## What to Tell Your User
Open a card and tap **Original message** to return to the request that started it. **Keep looking** checks more history when needed. Your card's own conversation stays separate.

## Summary of New Capabilities
A console source backlink and message-target navigation through the existing signed reader. No new permissions or server endpoint. Existing cards with a stored source gain the link; no data migration is needed.

## Evidence
Signed-reader page tests, independent review and Chromium checks at390 and1280 pixels. See upgrades/side-effects/dashboard-card-source.md.
