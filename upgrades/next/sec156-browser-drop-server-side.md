# A browser-only Secret Drop password is typed by the agent server and never handed to a session

<!-- bump: patch -->

## What Changed

SEC-156. A Secret Drop request made with `browserHost` is meant to be typed into one website's sign-in page and never read. The rule was enforced only in the helper script, though. `POST /secrets/retrieve/:token` returned the value to any caller holding the agent key, so any session could read the password. Now the retrieve route answers `409 browser-only` for such a drop, on peek and on consume. It returns the field names, the host and the origin, never the value. The new `POST /secrets/type/:token` (`{ field, profile }`) has the agent server run the agent's own browser driver (`.instar/scripts/browser/xdrive.sh typesecret <host>`) with the value on standard input, returns `{ typed, exitCode, consumed, output }` and removes the drop only after a typed success. The Secret Drop helper's `--browser` mode now calls that route, so nothing changes for whoever uses it. `/secrets/type` needs the same fresh-PIN step-up as `/secrets/retrieve` for a dashboard session token.

## What to Tell Your User

- **Browser passwords stay out of sessions**: "When you send me a password that is only for signing in to one website, my sessions can no longer read it. My server types it into the page itself."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Server-side typing of a browser-only Secret Drop password | Automatic, through the Secret Drop helper's `--browser` mode |

## Evidence

- `tests/integration/linux-browser-routes.test.ts`: retrieve answers 409 with names and host and no value, on peek and on consume. The real route hands the stored host and the value on standard input to the driver, returns no value, and consumes on success. A failed type keeps the drop. An unknown field and a bad profile are refused.
- `tests/integration/secret-drop-store-first.test.ts`: retrieve refuses the browser password, and the server-side type consumes it with no vault write.
- `tests/e2e/secret-drop-store-first-lifecycle.test.ts`: on a real AgentServer, the 409, the 401 without the key, the typed result, and the drop gone afterwards.
- `tests/unit/normal-chrome-linux-wrapper.test.ts`: the helper sends the field and the browser profile, never sees the value, and reports success or the driver's exit code.
- `tests/unit/dashboard-session-store.test.ts`: `/secrets/type` needs the step-up.
