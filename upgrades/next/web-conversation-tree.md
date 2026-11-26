<!-- bump: patch -->

## What Changed

The web conversation views can render the shared owner conversation tree when the server provides the Projects, Groups, and Ungrouped sections. The Chief of Staff stays at the top in Tree view. Sections start open and remember what you collapse. Flat view provides an activity or name sort.

## What to Tell Your User

On a server that provides the shared tree, your chats use the same grouping on the web. You can collapse a group in place or switch to Flat to scan individual chats.

## Summary of New Capabilities

The web can display nested shared conversation sections using the existing owner-authorized reads.

## Evidence

Focused console tests exercise both authorization paths, nested placement, pinned project chats and stored collapse preferences. A disposable visual fixture checks the pending shared response shape at 390 and 1280 pixels. The authoritative mixed fixture and real owner pairing are release evidence.
