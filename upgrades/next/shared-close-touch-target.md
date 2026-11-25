# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The dashboard's shared dialog close button now reserves a44 by 44 pixel target. This fixes the phone-sized target without changing the button label or dismissal behavior.

## What to Tell Your User

The close button in dashboard detail dialogs is easier to tap on your phone.

## Summary of New Capabilities

None; this repairs the size of an existing control.

## Evidence

Ordinary Chrome sample-data checks compare baseline and candidate at phone/desktop widths, both themes and larger title text, using actual pointer hits and dismissal. Existing focused UI checks pass. Complete verification, release and installed-phone confirmation remain separate.
