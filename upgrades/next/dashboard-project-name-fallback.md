# Project headings do not fall back to IDs
<!-- bump: patch -->

## What Changed
The Work page uses the shared console name validator for project headings. Missing or ID-only titles display “Project name unavailable”; original keys and conversation destinations remain intact.

## What to Tell Your User
A project whose name cannot be read now says “Project name unavailable” instead of showing an internal ID. You can still open its conversation.

## Summary of New Capabilities
No setup or permission changes. This corrects an existing project label.

## Evidence
42 project/model tests pass, an independent review concurs, and desktop/phone browser checks preserve the destination link. See the side-effects artifact for final full-suite validation.
