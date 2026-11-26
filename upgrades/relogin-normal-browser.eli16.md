# Sign-in repair now uses a normal browser — plain-English version

When one of your Claude or Codex subscriptions gets signed out, Instar can sign it back in by itself: it opens that account's own Chrome, goes through the sign-in pages, and checks the right account came back. Until now it did that with a remote-controlled Chrome — a Chrome started with a special debugging connection so a program can drive it.

Sign-in sites treat remote-controlled browsers as suspicious. On 2026-09-24 Claude's "Authorize" button simply never went through for the remote-controlled Chrome, and a Cloudflare "Just a moment" check got stuck on one profile. Every time the same thing was tried in a Chrome opened the ordinary way, it passed.

So the rule is now: sign-ins always run in a normal browser. On a Mac, Instar opens the account's Chrome exactly the way double-clicking it would, with no debugging connection. It then reads the page and presses buttons using Chrome's own built-in scripting feature (the same one AppleScript uses), switched on only in that account's profile. Everything else stays the same: it can still only be on the real sign-in sites, never picks a different account, never shows a password or code to the model, never presses buttons like "sign out" or "delete", and still confirms the signed-in account at the end.

This was proven on a real expired sign-in (justin@sagemindai.io on the Studio): the normal Chrome went through Authorize on the first click and the account is active again.

What you might notice: a Chrome window may flash open and close on the machine while a repair runs. On non-Mac machines nothing changes yet. Nothing needs deciding.
