# ELI16 — Stop crying "sign in again" when the login is actually fine

## The plain-English version

When you log into Claude, your computer gets two keys, not one:

- A **short-lived key** (the "access token"). It only works for about 8–12 hours, then it goes stale. This is normal and happens every single day.
- A **long-lived key** (the "refresh token"). It lasts weeks to months. Whenever the short-lived key goes stale, your Claude app quietly uses the long-lived key to mint a brand-new short-lived one. You never see this happen — it's automatic.

So the long-lived key is the real "I am logged in." The short-lived one is just a daily disposable.

## What was broken

We have a background checker (the quota poller) that peeks at each account to see how much of your usage limit is left. To do that it grabs the short-lived key and asks Anthropic's servers. **But it never did the "use the long-lived key to get a fresh short-lived key" step.** So every day, the moment the short-lived key went stale, the checker got a "not allowed" answer and concluded: *"this login is dead — the user has to sign in again."*

That was wrong. The login was perfectly fine. Only the disposable daily key had expired. The result: accounts showed "needs sign-in" overnight even though nothing was actually wrong — exactly the confusing thing you ran into ("how did they go stale already? I thought this was a one-time thing").

## What this change does

Now, when the checker gets that "not allowed" answer, it first tries the same automatic refresh the Claude app does: it uses the long-lived key to mint a fresh short-lived key, saves it, and tries again. If that works, the account just keeps working — no sign-in prompt, nothing for you to do. Only if the **long-lived** key is genuinely dead (you changed your password, signed out, or a new login elsewhere bumped it) does it say "needs sign-in" — which is what that label was always supposed to mean.

It also shows a small "token auto-refreshed" note on the dashboard so you can SEE it's handling this for you, instead of guessing.

## Why it's safe

The only risky part is saving the new key back. If it saved a bad key, it could break a working login. So the save only happens after the new key passes a strict shape check, and it's a read-merge-write that keeps every other field exactly as it was. If anything about the refresh fails — wrong answer, network blip, anything — it writes nothing and falls back to the old "needs sign-in" behavior. Worst case is "no improvement," never "broke your login."

## What you need to decide

Nothing to configure. This is automatic and on by default for the quota checker. The real-world question is just whether the refresh actually succeeds against your live accounts — which is verified by watching a currently-stale account recover after this ships.
