# Side-Effects Review — Telegram origin tool guard matches managed profiles per path component

**Version / slug:** origin-guard-prefix
**Date:** 2026-11-08
**Author:** Echo
**Feedback / commitment:** fb-bd431d9f-0a7, CMT-1473
**Second-pass reviewer:** independent subagent (see end)

## Summary of the change
Tier 1. One runtime file (`src/messaging/telegram-origin/OriginToolGuard.ts`, about 12 lines) and one unit test file. The generated `telegram-origin-guard.js` hook decided "this command touches the broker-owned Telegram profile" with `text.includes(dir)`. Any profile whose path merely starts with the managed path (for example `.../playwright-profiles/justin-telegram-room4`, not broker-owned) was refused as `managed-telegram-profile-private`, so the desk could not diagnose or sign in the proof-room profiles. Now the managed dir counts only when the character after it does not continue a file name (letters, digits, `.`, `_`, `-`). A separator, quote, whitespace, shell separator or end of text still counts. The list of managed dirs (registry path plus its realpath) is unchanged. Effort: no spec rounds; one commit.

## Decision-point inventory
- Origin tool guard, rule `managed-telegram-profile-private`: an existing blocking hook. Its match is narrowed from substring to whole path component. Every other rule (Telegram MCP writes, the Telegram web client in browser tools, Bot API writes, browser profile flags combined with the Telegram web client) is byte-identical.

## 1. Over-block
Removes the over-block that motivated the fix: a sibling profile whose name extends the managed name. No new over-block. A command that only mentions the managed path as text (for example `ls .../justin-telegram` with a browser word) is still refused, as before.

## 2. Under-block
A path that continues the managed name with a filename character (`justin-telegram.bak`, `justin-telegram-room4`) is now allowed. Those are different directories, so a browser opened on them cannot read the managed profile. The second-pass review found one spelling the old substring check caught only by accident and a pure whole-path match would miss: `.../justin-telegram-room4/../justin-telegram`. The matcher therefore also refuses the managed folder's own name after a `..` step (`../justin-telegram`, `..\justin-telegram`), with the same whole-name rule. That also catches `.../other/../justin-telegram`, which the old check missed. A second review round found `.../room4/.././justin-telegram` and `.../room4/..//justin-telegram`; the matcher now also checks a tidied copy of the text (repeated separators collapsed, `./` steps removed), which also catches `.../profiles//justin-telegram` and `.../profiles/./justin-telegram` (missed before too). Small new over-block: a `../justin-telegram` that leads to an unrelated folder of the same name is refused. Other spellings (a bare relative path without `..`, `~`, a symlink other than the realpath) were not caught before either; unchanged. The rule is a negative class (refuse unless a filename character follows) rather than a short positive list of terminators, so shell separators such as `;` `)` `|` and backslash still refuse.

## 3. Level-of-abstraction fit
The fix sits in the one classifier that owns this rule. No other layer decides managed-profile ownership for tool calls; the server-side broker still owns the profile at runtime.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. This is an existing cooperative blocking boundary (documented in the file as "not an OS sandbox"). The change narrows a brittle substring match to a precise one; it adds no authority.

## 4b. Judgment-point check
None.

## 5. Interactions
The guard digest is computed from the hook text, so it changes. The server compares the native-hook proof digest against `originToolGuardDigest()` from the same build, and `OriginInstallation` compares the installed file against `originToolGuardHook()`. `PostUpdateMigrator` rewrites `hooks/instar/telegram-origin-guard.js` on every update, so the installed hook and the server move together. Between hook install and server restart a session's proof digest may not match until the server restarts on the new build; that is the existing behavior for any guard change (missing proof holds activation, it never obstructs tools).

## 6. External surfaces
Agent sessions can now run browser or shell commands naming non-broker sibling profiles. No change to messages, routes or other agents.

## 7. Multi-machine posture
Machine-local BY DESIGN: each machine generates its hook from the shipped code and reads its own profile registry. Every machine gets the same fix through its own update.

## 8. Rollback cost
Plain revert and release; the migrator rewrites the hook. No state or data migration.

## Second-pass review
Three rounds. Round 1 raised `room4/../justin-telegram`; round 2 raised `room4/.././justin-telegram` and `room4/..//justin-telegram`. Both fixed (`..`-step needle; tidied copy of the text). Round 3: Concur with the review.
- The `..` and separator spellings are closed in shell and browser-tool JSON form, including a shell backslash and a registry entry ending in `/`; earlier quote, JSON, URL-decode and trailing-slash cases still refuse.
- No new over-block: `room4/.//justin-telegram-room1` and `justin-telegram.bak` are allowed.
- Known leftover, not a blocker: splicing quotes into the path (`room4/..""/justin-telegram`) gets through; the old check caught that one only through the sibling prefix, and quote splicing already defeated the old check in general (`/p/justin-telegra''m`). The guard is cooperative, not an OS sandbox.
- Tests pass 20/20.
