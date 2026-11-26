<!-- bump: patch -->

## What Changed

The web conversation views can render the shared owner conversation tree when the server provides the Projects, Groups, and Not in a group yet sections. The Chief of Staff has a pinned card at the top of Grouped view. Sections start open and remember what you collapse. Flat view provides an activity or name sort.

## What to Tell Your User

On a server that provides the shared tree, your chats use the same grouping on the web. You can collapse a group in place or switch to Flat to scan individual chats.

## Summary of New Capabilities

The web can display nested shared conversation sections using the existing owner-authorized reads.

## Evidence

Focused console tests exercise both authorization paths, nested placement, pinned project chats and stored collapse preferences. Chromium checks at 390 and 1280 pixels use the response from a signed disposable server. Real owner pairing and combined linked-card acceptance remain pending.
