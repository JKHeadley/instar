<!-- internal-only -->
## What Changed
The locked-screen proof driver (`scripts/locked-proof/driver.mjs`) waited for the remote-desktop viewer page with a selector list whose first match was the hidden "Open selected machine" button. When the page opens the stream by itself, which it does when exactly one machine is ready, that button stays enabled but hidden, so the wait timed out after 20 seconds and calibration failed before any case ran. Both alternatives of `VIEWER_READY` now require `:visible`. Proof tooling only; no runtime code changes.

## Evidence
Live on the Mac Mini, 2026-11-05: `driver.mjs calibrate --execute` failed with "page.waitForSelector: Timeout 20000ms exceeded … 37 × locator resolved to 2 elements. Proceeding with the first one: <button id="requestButton">". The same command with the `:visible` selector wrote calibration.json at 18:36:18Z, and the 30-case run started after it. A new unit test in `tests/unit/locked-proof-driver.test.ts` fails on the old selector, because `#control:not([hidden])` does not end in `:visible`; all 50 tests in the file pass with the fix.
