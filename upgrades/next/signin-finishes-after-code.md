## What Changed
- **A sent sign-in code is now finished by the agent, not left hanging.** After you paste the code from the sign-in page, the machine doing the sign-in now watches it to the end (about two and a half minutes at most) and finishes it through the normal checked path: the account is added back as active, or the sign-in ends as failed with a plain reason (a different account signed in, the sign-in window closed without finishing, or it ran out of time). Before, it said "code sent; finishing sign-in" and nothing finished it except a background check every five minutes, which could not see the new sign-in at all (next point).
- **Instar reads the same saved login the Claude CLI uses.** On a Mac, one account's saved login can exist twice in the keychain, filed under two different user names. Instar used to read whichever copy the keychain listed first, so after a successful re-login it could keep reading an old, dead copy: the account stayed "needs sign-in", the usage reading never updated, and the new sign-in was never noticed. Instar now reads the CLI's own copy first, and writes under the same user name the CLI uses.
- **The sign-in window shows that it is working.** In the console (Accounts → Sign in), once you send the code the form goes away and a large "Finishing the sign-in on <machine>…" with a spinner takes its place, then "Signed in as <email> on <machine>." with one Done button, or what went wrong with one "Start the sign-in again" button. The older Subscriptions tab does the same in its sign-in rows and grid cells.
- **A usage read that gets an error now says so in the log** instead of skipping the account silently.

## What to Tell Your User
When you sign an account back in and paste the code, the window now clearly shows that it is finishing, and then tells you either "Signed in as …" or why it did not work, with one button to try again. You no longer have to wait on a small line that looks stuck, and the account comes back by itself once the sign-in really worked.

## Summary of New Capabilities
- Server-driven completion after a sent sign-in code, with a bounded wait and a terminal done or failed state.
- `GET /subscription-pool/follow-me/completion?machineId=&id=` (relay) and `GET /subscription-pool/follow-me/enroll/:id/completion` (this machine) report `finishing`, `done` (with the email) or `failed` (with a reason).
- Claude credential keychain reads match the CLI's item.

## Evidence
- `tests/unit/follow-me-completion-watcher.test.ts`: the credential lands → done and the account is upserted; the window closes with no sign-in → failed `window-closed` with no attention item and the login left open; a no-keychain host whose slot answers live as the expected account → done; nothing lands → failed `timed-out` at the bound; a different account → failed `wrong-account` naming both; cancelled → `cancelled`; finished by the background sweep → done.
- `tests/integration/account-follow-me-completion-route.test.ts`: over HTTP, submit → `submitted` with `finishing` → `done`, login completed, pool row active; window exits with no sign-in → `failed`, account stays needs-reauth; timeout → `failed`; local read states; relay 502/400.
- `tests/unit/claude-keychain-account-read.test.ts`: with a stale item listed first, every read (credential store sync and async, swap-executor revision read) returns the CLI's item; a lone item under another account is still found; no item → null.
- `tests/unit/console-accounts.test.ts`, `tests/unit/console-signin-progress-model.test.ts`, `tests/unit/subscriptions-completion-follow.test.ts`: the form is replaced by the in-progress view, then done or failed with one action.
- Live diagnosis (Mac Studio, 2026-11-10): the `Claude Code-credentials-8aa0bca8` service held two items, `acct="unknown"` last written 2026-11-08 (token expired 2026-11-08 10:27 UTC; the usage endpoint answered 429) and the CLI's `acct=<user>` item updated 19:16:18 UTC by the re-login.
