# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The dashboard refreshes up to 200 loaded Conversations rows together and keeps the previous list when the server reports incomplete coverage. The list response adds an inventory coverage field. Open browser tabs keep their own page depth.

## What to Tell Your User

Older rows in Conversations can now update along with the first page. If a computer cannot be reached, the dashboard keeps your last loaded list and offers a retry.

## Summary of New Capabilities

This repairs existing list refresh behavior. There is no new setting.

## Evidence

The focused renderer, signed HTTP and server lifecycle checks passed, as did type checking. A private signed replay exercised the candidate with the pending work-card visibility change.
