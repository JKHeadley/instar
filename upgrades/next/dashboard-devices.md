<!-- bump: patch -->
## What Changed

The web dashboard calls the page Devices and shows paired phones, native computers, and linked document browsers in one list. Each row identifies its kind. The same page can start linking the current browser for Conversations.

## What to Tell Your User

Open People, then Devices to see your paired phones and computers together. Use **Link this computer** to start linking the browser you’re using.

## Summary of New Capabilities

The existing device response includes display metadata for device kind and links for Documents. The dashboard starts the existing browser enrollment directly from Devices.

## Evidence

A disposable browser exercised enrollment and the unified list at 1280 and 390 pixels. Focused renderer, HTTP and lifecycle tests cover the Devices page and its existing pairing route.
