# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Work project rows now show an explicit High, Normal or Low priority. The owner can set it with the existing dashboard unlock. Unset projects remain Normal. The preference is a separately replicated Chief of Staff record, so it does not rewrite a goal, reset completion checks or remove a pause. The save waits for durable journal recording.

## What to Tell Your User

You can now mark which projects matter most to you on the Work page. Open a project and choose High, Normal or Low. This records your preference for the later pacing assessment; it does not yet move work, change a model or override a pause.

## Summary of New Capabilities

Owner-set project priority, visible through existing Work project reads and the Chief of Staff project detail. Bearer-only agents cannot change it.
