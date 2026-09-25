# Skill-driven sign-in repair: the plain-English version

## The problem

Instar runs several Claude and Codex subscriptions. Now and then one of them gets signed out and has to be signed in again. Instar has an automatic "sign-in repair" for this. It starts the login from the command line, opens that account's own Chrome, clicks through the Google and Claude pages, and then checks that the right account came back.

It has never once finished a real repair on its own. The page-clicking part follows fixed rules like "if you see this page, click that button". Real sign-ins keep showing things the rules never expected: Chrome's own "Sign in to Chrome" window, Google opening a popup, a permissions page worded slightly differently. On 25 September the rules stopped both Laptop accounts within three seconds. They also treated those stops as security problems, which locked each account out of any retry for a day.

An hour later, an ordinary agent session signed both accounts in within about ten minutes, just by following the written sign-in guide. It looked at the screen, clicked, typed, and handled the popup the way a person would. The same approach had already fixed the Mac Studio the day before.

Justin's direction was clear: use the best tool for the job, and when needed, work like a human using the same screens rather than like "automation". The older rule still stands: sign-ins happen only in a normal Chrome, never a remote-controlled one.

## The change

On a Mac, the page-clicking step is handed to a short-lived agent session that works like a person. Everything else stays in code exactly as today:

- deciding a repair is needed and allowed;
- starting the login;
- passing the final code to the login;
- checking the signed-in email is the expected one;
- checking the account actually works;
- keeping the record.

The session's word never counts as success. Only those server checks do.

## The safety rails, in code

- **The session never sees a password.** When it needs one, it asks the server to type it. The server first checks that the front Chrome window is the one it opened for this repair. It checks that the page is a real Google, Claude or OpenAI sign-in page, and that a text box on that page has the keyboard focus, so it cannot type into the address bar. Only then does it type. Afterwards it checks again that the text landed in that same box. If it didn't, the repair stops and Justin is asked whether to change the password.
- **The code goes through the server.** The code Claude shows at the end goes back through a route that only this repair's session can use, and only once.
- **Time is limited.** The session runs for at most 15 minutes, and never longer than the login it is approving. A repair gets at most three tries, and a stopped session is never brought back.
- **One at a time.** Only one such session runs per machine at a time. It runs on a different, healthy Claude account, never on the account it is repairing, and it starts only when the screen is unlocked and there is room for another session.
- **It asks Justin in a fixed way.** If the session needs something only Justin can do, like tapping "Yes" on his phone, the server sends one fixed message saying exactly what to tap. The session cannot chat to him freely.
- **Its stop reasons hand off but don't lock out.** If the session reports a CAPTCHA, a "verify it's you" check, or the wrong account, the repair hands off to Justin. None of those reports locks the account for a day. Only a proven wrong account, measured by the server, does that.

## What a Mac needs first

Each Mac needs three macOS permissions granted once:

- permission for the helper to see the screen;
- permission to click and type;
- permission to control Chrome.

These can't be granted from a phone. Before each repair, the system checks for them, and if one is missing it says exactly which. Until then, that Mac's repairs fall back to Justin's phone.

## What stays the same

On machines that are not Macs, the old page-clicking driver still runs, because there is no normal-browser way to do this there yet. Turning the old behavior back on is a single setting.

## Rollout

It is tried first on a throwaway test agent against fake sign-in pages. Then it runs on Echo's own Macs, where Justin approves each repair with one tap at first. Other agents get it only after at least five verified repairs, across both Claude and Codex and on at least two kinds of machine, with no wrong-account results.

## Honest leftovers

- If every other Claude account on the same machine is also signed out, there is nothing to run the helper session on. As happened on the Laptop on 25 September, that case still needs Justin. He can do it from his phone: the dashboard shows the sign-in link, and he pastes the code back there.

- The session can still click in the wrong place on screen.
- A page could try to trick it with hidden instructions.
- A deliberately misbehaving session could read files on the machine. That is the same level of trust any agent session on the machine already has, which is why it starts with Justin approving each repair.

These risks are limited because the session never holds a password, cannot message anyone freely, is stopped after 15 minutes, and cannot mark a repair as successful. They are written down rather than hidden.
