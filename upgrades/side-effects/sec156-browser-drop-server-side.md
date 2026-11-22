# Side effects: a browser-only Secret Drop is refused by retrieve and typed server-side (SEC-156)

In plain words: a Secret Drop requested with `browserHost` should only ever be typed into that site's page. The "browser only" rule lived in the helper script. `POST /secrets/retrieve/:token` returned the value to any API-key caller, which includes any session. Now the server never returns that value, and it types the password into the browser itself.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: `src/server/routes.ts` (the retrieve refusal and a new route), `src/server/middleware.ts` (one step-up entry), and `src/templates/scripts/secret-drop-retrieve.mjs` (`--browser` calls the new route). Tests: two unit files, two integration files and one end-to-end file updated.

## What changes for running agents
- **`POST /secrets/retrieve/:token`.** For a drop with `browserHost` it answers `409 { error: 'browser-only', detail, browserHost, label, origin, fieldRefs }`, before any consume, and with no value. A browser drop is never persisted (the drop POST skips the durable copy when `browserHost` is set), so the durable fallback never sees one. Other drops are unchanged.
- **`POST /secrets/type/:token`** (bearer, `{ field, profile }`). The field is a name or `#N` and must be the drop's own key (`hasOwnProperty`). The profile must match `^[A-Za-z0-9._-]{1,64}$`. The driver path is `<stateDir>/scripts/browser/xdrive.sh` (503 if missing), never caller-controlled. It runs `xdrive.sh typesecret <browserHost>` through `execFile` (no shell), with the value written to standard input, `XD_SECRET_BROWSER=1` and `XD_PROFILE=<profile>`, a 180-second timeout and a 256 KB output cap. xdrive itself starts the driver in a clean `env -i` environment. The route answers `{ typed, exitCode, consumed, browserHost, output }`, where `output` is the last 2,000 characters of the driver's own messages. On exit 0 it consumes the in-memory drop. On failure it keeps the drop for a retry, the rule the helper had. One run per drop at a time (409 `typing-in-progress`). Annotated `@write-domain:none`: it removes only the in-memory drop, with no durable or replicated write.
- **The helper's `--browser`** posts `{ field, profile: $XD_PROFILE }` to the new route and prints the driver's messages and the same success or failure lines as before, with the driver's exit code. `--names` uses the 409's field names, and every other mode prints the existing "leaves only with --browser" refusal. Its old local typing block is now a refusal ("update the agent"), so it never handles a value. Updates rewrite the helper (`refreshScripts`), so it and the server change land together.
- **Dashboard session tokens.** `/secrets/type` joins `/secrets/retrieve` on the fresh-PIN step-up list (`DST_CREDENTIAL_PREFIXES`).

## Signal vs authority
This removes the value from every caller of the API. The session keeps the same authority to start a sign-in, which is the designed path, but it never holds the password.

## Rollback
Revert the commit. The helper reverts with it on the next update. No stored data changes.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding, the diff and this note), 2026-11-22. Verdict: CONCUR. It found no API path that still returns a browser drop's value. The retrieve refusal comes before consume and before the durable fallback. Browser drops are never persisted. `listPending` and the stuck-consumer event carry no values, and no threadline, mobile or sync path reads them. It confirmed the type route is safe. The field lookup is own-key only. `browserHost` is validated at request time and stored server-side. There is no shell, the profile and driver path are fixed, and single-flight is cleared on every path. The driver reads the value from standard input only. It confirmed parity: the session contributed only `XD_PROFILE` and the marker, and xdrive is Linux-only, so the macOS and Windows flows are unaffected. Its notes, all taken: the consume expression is simplified to follow `typed`. The helper's old local typing block is now a plain refusal, so a helper meeting an older server that still returned a value never handles it. Tests were added for `__proto__` and `constructor` as the field, and for two concurrent typing calls. Recorded, not changed: a session's `XD_EXPECT` and `XD_CHROME_FLAGS` no longer reach the driver, which is minor. A client that disconnects mid-type leaves the drop unconsumed even after a successful type, which is safe.

## Tests
- `tests/unit/normal-chrome-linux-wrapper.test.ts`: the helper's fake server answers like the new server. `--browser` sends the field and profile, never sees the value, and reports success or the driver's code. Every other exit still refuses, and `--names` shows no length.
- `tests/unit/dashboard-session-store.test.ts`: `/secrets/retrieve` and `/secrets/type` need the step-up.
- `tests/integration/linux-browser-routes.test.ts`: 409 on peek and on consume with no value. The real route hands the stored host and the value on standard input, with the marker and profile, to a recorder driver, returns no value, and consumes, so a second type gets 404. A failed type keeps the drop. An unknown field, `__proto__` and `constructor` get 404, and a bad profile 400. Two concurrent calls give one 200 and one `typing-in-progress`.
- `tests/integration/secret-drop-store-first.test.ts`: retrieve refuses the browser password, and the type consumes it with no vault write.
- `tests/e2e/secret-drop-store-first-lifecycle.test.ts` (real AgentServer): 409, 401 without the key, a typed success with no value in the response, then 404.
- Run here: the two unit files (35 tests) and the write-domain ratchet, all passing. Typecheck is clean. Integration and end-to-end coverage comes from Local Verify, because this machine does not run them by hand.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. One driver run per request, single-flight per drop, no retry or schedule.
