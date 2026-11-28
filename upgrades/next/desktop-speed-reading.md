# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Remote Desktop viewer has a Speed button in its controls menu. When it is on, it shows the typical and worst delay from a click, key press or scroll to the remote screen changing, and how many pictures a second arrive while the screen changes. Moves, releases and modifier keys are not timed, because the Mac helper does not draw its own pointer. Nothing is stored; the numbers live in that browser only.

## What to Tell Your User

You can now see how fast Remote Desktop feels. Tap Speed in the controls menu, then click, type or scroll a few times, and it shows the delay and how smooth the picture is, for example "Delay 80 ms typical, 140 ms at worst · 16 pictures a second while it changes".

## Summary of New Capabilities

A measured input-to-screen delay and picture rate in the Remote Desktop viewer, off until tapped.

## Evidence

An independent reviewer checked it in two rounds. The 14 unit files that evaluate or read the desktop viewer pass (221 tests), including 18 cases for the meter itself.
