# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Needs you Hide and list action buttons, and the Conversations Overview and All tabs, now have a minimum target of 44 pixels in both dimensions. Their actions and saved state stay the same.

## What to Tell Your User

The buttons for hiding or expanding Needs you, and switching Conversations views, are easier to tap on your phone.

## Summary of New Capabilities

No new setting or capability. This repairs the size of existing controls.

## Evidence

The served dashboard files with sample content reproduce undersized targets at 390 and 1280 pixels in both themes. Cardinal hit tests establish the actual click boundary. All 235 existing focused Needs you, Conversations and front door checks pass. Candidate browser comparison covers control interactions and a 25 percent enlargement of relevant text. Complete verification remains required for the published exact head; no live or physical phone claim.

Final browser evidence: 16 candidate cases at 390 and 1280 pixels, both themes and normal or 25 percent larger relevant text after every repaint. All scoped targets meet 44 pixels in both dimensions. Cardinal hits, nonoverlap, scrolling and control interactions pass with zero script errors or application writes. Both final manifests bind the candidate CSS hash. This is sample-content desktop-browser evidence, not physical phone or full zoom certification.
