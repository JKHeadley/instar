# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The dashboard refreshes up to 200 loaded Conversations rows together and keeps the previous list when the server reports incomplete coverage. The list response adds an inventory coverage field. Open browser tabs keep their own page depth. Conversation history shows loading and retry status while preserving the open conversation.

## What to Tell Your User

Older rows in Conversations can now update along with the first page. If a computer cannot be reached, the dashboard keeps your last loaded list and offers a retry.

## Summary of New Capabilities

This repairs existing list refresh behavior. There is no new setting.

## Evidence

On main base `646c926a6`, 58 renderer tests, 12 signed HTTP tests, one production server lifecycle test and one signed HTTP-to-renderer replay passed. The replay verified that an answered card leaves the loaded list while the neighboring conversation and stored history remain. Full verification will run on the published commit.
