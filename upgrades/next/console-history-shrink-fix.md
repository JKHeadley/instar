## What Changed

The console's session History view showed an empty box: its entries were squeezed to zero height. Each entry now keeps its height and the box scrolls; on desktop it fills the same space as the live view.

## What to Tell Your User

The History view on a session now actually shows the conversation; before, it could look empty.

## Summary of New Capabilities

No new capability; a layout fix.

## Evidence

Live check on 1.3.1586 (2026-11-02): 1,050 History entries loaded with height 0; after the fix, entries are 18.6 px tall and visible in a headless Chromium screenshot.
