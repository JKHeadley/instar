# Sign-in finishes after the code — plain overview

## What happened

On 2026-11-10 the operator signed a Claude account (gearfinity3d) back in from the console. He opened the sign-in page, got a code, pasted it, and pressed "Send the code". The window then showed a small grey line, "code sent; finishing sign-in", under the same form, with every button still live. It looked stuck. In fact the sign-in had worked: the Claude program on the Mac Studio had saved a fresh login and answered a real request with it. But the account stayed marked "needs sign-in" until Echo finished it by hand, and even after that the usage reading for the account never updated.

## Why it stranded

Two things went wrong together.

First, after the code was typed in, the server waited two seconds, then answered "finishing" and walked away. The only thing that could finish the sign-in later was a background check that runs every five minutes, and nothing told the page what happened.

Second, and deeper: that background check, the usage poller and the identity check all read the saved login from the Mac keychain by its service name only. This account's service had two saved items, filed under two different user names. One was an old copy last written on 2026-11-08, whose token had expired. The Claude program reads and writes its own copy, filed under the Mac user name. The keychain listed the old copy first, so instar kept reading the dead token. That is why the account kept falling back to "needs sign-in" for two days, why the background check could never see that the new sign-in had changed anything, and why the usage reading stayed frozen after the hand repair.

## What changes

- Instar now reads the Claude login the same way the Claude program does: its own copy first (filed under the Mac user name), and only falls back to any other copy if that one is missing. Writes use the same user name too.
- After a code is sent, the machine doing the sign-in keeps watching it, every two seconds for up to about two and a half minutes, and finishes it through the same checked path as before: the email the sign-in actually reached must match the account asked for. It ends in exactly one result: done (the account is active again) or failed, with a plain reason: a different account signed in, the sign-in window closed without finishing, the sign-in was cancelled, or time ran out.
- The page asks for that result and shows it. As soon as the code is sent, the form disappears and a large spinner with "Finishing the sign-in on Mac Studio…" takes its place. Then it shows "Signed in as …" with a Done button, or what went wrong with one "Start the sign-in again" button. The older Subscriptions tab does the same.
- When the usage read gets an error answer, the log now says so instead of skipping the account in silence.

If adding the account back to the list fails after a confirmed sign-in, that failure is now reported to the agent's problem log instead of only a log line, and the dashboard's question to another machine about a sign-in goes through the same path as every other machine-to-machine read, so a slow or unreachable machine shows up in the mesh health view.

## Safeguards

The finishing step never trusts a file just being there: it needs either the saved login to have changed since the sign-in started, or (only once the sign-in window has closed) a live check against Anthropic that names the expected account. A different account is never added. A failure leaves the account as it was, so a retry starts clean. The wait is bounded, and only one watch runs per sign-in.

## What you need to decide

Nothing. This is a bug fix to an existing flow. It can be undone by reverting the change; it adds no stored data.
