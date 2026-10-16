# threadline-mcp 0.4.5: it connects again

## What Changed

`threadline-mcp` 0.4.4 called `require('http')` inside an ES module (in `isListenerAvailable` and `sendViaListener`), so every relay connection threw `ReferenceError: require is not defined` before it started. Nothing using 0.4.4 could connect. This imports `node:http` instead. No other change.

## What to Tell Your User

If your agent uses Threadline through threadline-mcp, the last version couldn't connect to the relay at all. This one does.

## Summary of New Capabilities

- None. A fix only.

## Evidence

- Before: running the built 0.4.4 server prints `Initial relay connection failed: ReferenceError: require is not defined` (confirmed in the published 0.4.4 tarball).
- After: the same run reaches the network (`connect ECONNREFUSED` against an unused port). The full stdio test in #2196, with the same fix, connects to a real relay and completes a pairing.
- The version is set to 0.4.5 by hand (Echo's review), and the publish workflow now smoke-tests the built server before publishing: it fails on the 0.4.4 build (`require is not defined`) and passes on this one, both checked locally.
