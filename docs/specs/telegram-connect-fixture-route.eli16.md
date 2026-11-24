# Keep the Telegram connection test independent of the computer's routes

The main test run stopped because a test of Telegram connection timing waited for thirty seconds without finishing. This blocked other changes from being checked. The test creates a real local TCP server, deliberately pauses the event loop, and compares the old short connection window with the current longer one. That comparison is useful and stays in place.

The problem was in the test's second address. The test called an IPv6 address that it assumed would fail immediately. On the current computer, that address instead waits silently for the operating system's network timeout. Node does not apply its per-address attempt timer to the last address, so the test never gets the error it expects before its own deadline.

The repair makes Node deliberately block that second address within this test. It still connects to the real local server for the first address. The old connection window must still fail after the deliberate pause, and the production window must still succeed. The test also checks the distinct causes of the two failed address attempts. Its thirty-second limit stays unchanged.

This changes no production connection setting or retry permission. A deliberately blocked address remains outside the existing safe-retry classification. The repair can be undone with a normal revert. Focused tests and independent review support this change; the complete main verification remains the responsibility of the shared test queue. No production restart or Telegram message is needed to verify a test-only repair.
