# Skill-driven sign-in repair: the plain-English version

## The problem

Instar runs several Claude and Codex subscriptions. Now and then one of them gets signed out and has to be signed in again. Instar has an automatic "sign-in repair" for this, and it has never once finished a real repair on its own.

The part that clicks through the Google and Claude pages follows fixed rules. Real sign-ins keep showing things those rules never expected: Chrome's own "Sign in to Chrome" window, Google opening a popup, a permissions page worded a little differently. On 25 September the rules stopped both Laptop accounts within three seconds. They also treated those stops as security problems, which locked each account out of any retry for a day.

An hour later, an ordinary agent session signed both accounts in within about ten minutes, just by following the written sign-in guide. It looked at the screen, clicked, typed, and handled the popup the way a person would.

There is a second problem too. Three Codex accounts showed as "active" for days while they were actually signed out, because the system never asked the Codex program itself whether it was logged in.

## The change (the simple version Justin chose)

On a Mac, the page-clicking step is handed to a helper: a short-lived agent session that follows the sign-in guide, exactly like the hand-run sessions that worked. The helper is trusted the way any agent session on the machine is trusted. It types the account's password itself, fetching it from the vault without printing it anywhere. Before every burst of typing it checks two things: that the front window is the Chrome it opened, and that the box with the cursor is the password or code box.

The helper has four hard lines, and only four:

- sign in only the expected account;
- never try to get around a CAPTCHA or a "verify it's you" check;
- type passwords only on real Google, Claude or OpenAI pages;
- never touch a Chrome window it didn't open.

## What stays in code

The server still does the parts that must not depend on judgement:

- deciding a repair is needed;
- allowing only one helper per machine at a time;
- starting the login;
- taking back the final code through one small door that only this repair's helper can use.

Most importantly, the server alone decides whether the repair worked. The login has to complete, the signed-in email has to be the expected one, and a real call using the account has to succeed. Nothing the helper says counts as success.

## How the helper is chosen and bounded

- **Its account.** The helper runs on any other healthy account on that Mac, Claude or Codex, never the one being repaired. If there is none, Justin gets a link to the dashboard, where he can finish the sign-in from his phone.
- **Its time.** The helper runs for at most 15 minutes. Only one helper runs on a Mac at a time; if a second account also needs repair, it waits its turn without losing Justin's approval.
- **Its contact with Justin.** It cannot chat with him. If it needs him to tap "Yes" on his phone, or to click Allow on the Mac, the server sends one fixed message saying so.

## Locking out, and "is it really signed in?"

An account is locked out for a day only when the server itself has proven that the wrong account got signed in.

Whether an account counts as signed in will now come from the Claude or Codex program's own login check, together with a real call. It won't come from an old status that nobody re-checked. A network hiccup is not treated as "signed out"; only a clear "not logged in" answer, seen twice in a row, is.

## Rollout

- **Fake pages first.** It is tried on a throwaway test agent against fake sign-in pages.
- **Then Echo's own Macs.** There, Justin approves each repair with one tap, whatever the unattended setting says.
- **Then other agents,** only after at least five verified repairs across both Claude and Codex, on at least two machines, with no wrong-account results.

## Honest leftovers

- **Real trust.** The helper has real machine trust, so a tricky web page could in principle mislead it. The limits are the four hard lines, the 15-minute cap, Justin's approval at first, and the fact that it can never mark a repair as done.
- **Stray clicks.** The helper can click in the wrong place on the screen.
- **Correlated expiry.** If every account on a Mac is signed out at once, there is no helper to run the repair. Justin finishes it from his phone.
