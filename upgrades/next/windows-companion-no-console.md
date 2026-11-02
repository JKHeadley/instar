# Windows remote desktop helper runs without a terminal window

## What Changed

The Windows desktop companion is compiled as a windowless application instead of a console application, so starting it in the signed-in session no longer opens a terminal window on the user's screen.

## What to Tell Your User

The black terminal window that appeared on your Windows machine after enabling remote desktop no longer shows up. Remote desktop works the same.

## Summary of New Capabilities

No visible helper window on Windows.

## Evidence

Installed on Mama PC through the normal installer with this change: the running companion has no main window (MainWindowHandle 0), no window titled with its install path exists, and diagnostics report ready. Unit test tests/unit/windows-companion-no-console.test.ts.
