# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The web dashboard improves contrast for shared faint, muted, and accent text. Dashboard dialogs keep keyboard focus inside while open and return focus to the opening control on close when it is still present.

## What to Tell Your User

Small dashboard labels are easier to read. If you use the keyboard, Tab stays inside open dialogs and returns to the opening control after you close them.

## Summary of New Capabilities

This improves existing presentation and keyboard behavior. There is no new setting.

## Evidence

The painted contrast audit measured 1,356 text samples with zero below the threshold. The combined browser audit exercised 132 route, width, and theme cases and all eight Accounts and Files dialog cases. No sampled dialog lost focus or failed to restore its opener.
