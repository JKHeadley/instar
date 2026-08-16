# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

### Systems Dashboard CSS Fix — v3 Styles Restored

The Systems dashboard CSS was still referencing old v2 class names (`.capability-card`, `.cap-info`, `.cap-label`) while the JavaScript had been updated to generate v3 classes (`.cap-card`, `.cap-card-name`, `.cap-card-desc`, `.cap-grid`). This mismatch caused the dashboard cards to render without proper styling.

The CSS has been fully replaced with v3 styles covering: card grid layout, detail views, stat cards, process list indicators, and responsive grid breakpoints.

## What to Tell Your User

The Systems dashboard styling has been fixed. If the cards and layout looked broken or unstyled, that's now resolved — everything renders cleanly with the new card grid design.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Systems dashboard CSS fix | Automatic — dashboard renders correctly now |
