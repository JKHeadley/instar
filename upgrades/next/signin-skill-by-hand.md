# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The built-in `/subscription-signin` skill gains a "Signing in by hand" section, which is the procedure an agent follows as a person at the machine would. It opens the account's own Chrome normally, looks at every display with `screencapture`, reads the page through a pid-targeted Apple Event (`CrSu/ExJa`, parameter `JvSc`, `tab 1 of window 1`), clicks with `cliclick`, and types a password from the vault over stdin. It dismisses Chrome's "Sign in to Chrome" first-run window, follows Google's sign-in popup, focuses the window so Claude's Authorize button enables, and pipes the code into submit-code without printing it. The repair steps now say: when the built-in repair stops on a page rule (unexpected-origin, permission-expansion, timeout) and not on a real human check, sign in by hand instead of waiting for a retry. The table gains rows for the first-run window and for those false stops, and the hard rules gain "type a password only into Google's or Claude's own sign-in page". It also gains a proven **Codex device-code** recipe: read the code from the live login pane, call `enroll/<id>/complete` after "Signed in to Codex", and reissue on expiry. It adds safety lessons as well: verify the frontmost pid and `document.activeElement` before every keystroke, wait up to 15 s for Claude's Authorize to enable, cancel a Google passkey prompt in favour of password plus authenticator, and remember that pool `active` does not mean signed in.

Existing agents receive it through a new `PostUpdateMigrator.migrateSubscriptionSigninByHand`. A stock copy of the first shipped version, matched by hash, is replaced whole. A copy the agent has edited keeps its edits and gets the new section inserted before its repair table. The migration runs only once, keyed on the section heading.

## What to Tell Your User

When the automatic sign-in repair gets stuck on a page it doesn't recognise, your agent now knows to sign in the way a person would. It looks at the screen, clicks through, and types the password from its vault. It still stops and asks you for anything that needs your hands, such as a phone tap or a CAPTCHA.

## Summary of New Capabilities

- The sign-in skill carries a proven by-hand procedure for Claude/Google sign-in in a normal Chrome, and agents use it when the built-in repair stops on a false alarm.

## Evidence

- Laptop, 2026-09-25 17:32–17:44 UTC: the built-in repair had stopped both `sagemind-adriana` (`unexpected-origin`) and `sagemind-justin` (`permission-expansion`) within 3 s of Chrome opening. An agent session following this procedure signed both in about 10 minutes. Each ended `active`, with the right email and `identityDrifted: false`, `claude auth status` showing `loggedIn: true`, and a fresh authenticated quota read. The only human step was one phone "Yes" tap for justin@.
- Laptop, 2026-09-25 17:55–18:09 UTC: a second session following the recipe signed in `codex-adriana`, `codex-dawn-sagemind` and `codex-amrch` (new profile). Each one shows `codex login status` "Logged in using ChatGPT" with the matching id_token email, and pending-logins is empty. All three had read pool `active` for days while signed out. One stray keystroke landed in the operator's chat draft and was deleted unsent, which is where the focus-check rule comes from.
- Tests: `tests/unit/PostUpdateMigrator-subscriptionSigninByHand.test.ts` (4 cases: content, stock replace + idempotent, edited copy keeps edits, unrecognized/absent untouched); `tests/unit/init-subscriptionSigninSkill.test.ts` still green.
