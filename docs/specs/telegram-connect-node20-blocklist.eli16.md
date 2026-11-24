# Let the Telegram connection test pass on Node 20

The unit tests on main kept failing in one place: the Node 20 run of the Telegram connection timing test. Three main runs in a row on 2026-11-24 failed on the same line, so this was not a flake.

The test blocks its second, fake address on purpose so it fails at once instead of waiting on the computer's network routes. It does that with Node's `blockList` option. Node only added that option to `net.connect` in version 22.13. Node 20 ignores it without any warning, so the fake address reaches the real network and fails as "unreachable" (`ENETUNREACH` on CI, `EHOSTUNREACH` on a Mac), not "blocked" (`ERR_IP_BLOCKED`).

The fix keeps the strict "blocked" check on every Node that supports the option. On older Node it accepts only a real unreachable-route error. The first address must still time out, there must still be exactly two attempts, and the test that uses the production window is unchanged. No production code changes. A normal revert undoes it.
