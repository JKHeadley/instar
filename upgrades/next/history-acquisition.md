<!-- bump: patch -->
## What Changed

The Instar server can tell the owner's app which personal history providers are available on this machine. The acquisition worker can track an export through delivery, preview and a separate decision to copy it. Both providers start disabled.

## What to Tell Your User

If you already have an export file, select it in Imported to see what it contains before copying. Automatic requests appear in the app only when the chosen provider is ready on your machine.

## Summary of New Capabilities

The signed owner-device capability and private import conversation support account selection, status, cancellation and preview confirmation. File imports also verify the selected archive and share a writer lock with automatic imports.

## Evidence

The focused tests cover request replay, changed accounts and files, archive delivery, restart recovery and authorization. The device-signed HTTP integration and temporary-server lifecycle tests are in the acquisition test files. Live provider and desktop checks are required before enabling the primary button.
