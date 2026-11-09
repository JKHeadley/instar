## What Changed
The Telegram origin tool guard no longer treats a browser profile as the broker-owned Telegram profile just because its folder name starts with the same letters.
- **Whole-name match.** `managed-telegram-profile-private` now fires only when the managed profile folder appears as a whole path component: followed by a separator, quote, whitespace, shell separator or the end of the command. A longer name such as `.../justin-telegram-room4` is allowed.
- **Unchanged.** The managed folder itself (with a trailing slash, a nested path, quotes, its realpath, or reached through a `..` step) is still refused, and every other guard rule is identical. The installed `hooks/instar/telegram-origin-guard.js` is rewritten on update as before.

## What to Tell Your User
I can work with the extra Telegram test browsers again. A safety check was mistaking them for your main Telegram browser because their names start the same way. Your main Telegram browser is still protected exactly as before.

## Summary of New Capabilities
- Sessions can open and diagnose non-broker browser profiles whose names extend the managed Telegram profile's name.

## Evidence
- `tests/unit/telegram-origin/tool-guard.test.ts`: the managed profile is refused plain, with a trailing slash, a nested file, double and single quotes, whitespace, a `;`, through its realpath, and through a `..` step; `justin-telegram-room4` and `justin-telegram.bak` are allowed. The proof-room and realpath cases fail on the previous code (2 failed) and pass with the fix (20/20).
