# Secret Drop: a show/hide eye on secret fields — plain-English overview

## What this is

When the agent needs a password or a key from you, it sends you a Secret Drop link. That link opens a small form. Each secret field on that form used to show only dots while you typed, so you had no way to check what you had entered before pressing "Send Securely". A typo meant a failed sign-in later, and then a second round trip to send the secret again.

Justin asked for an eye button on these fields so he can see what he typed (commitment CMT-1250, 2026-11-03).

## What changes

- Every masked field now has an eye button at its right edge.
- Tap the eye and the field shows what you typed. Tap it again and the dots come back.
- The button's label changes between "Show what you typed" and "Hide what you typed", so screen readers announce it.
- The button is a large 44-pixel target, so it works on a phone.
- When you press "Send Securely", any field you revealed goes back to dots first. Nothing is left showing on a shared screen.
- Fields that are not secret, like a username, get no eye button.

## What does not change

The secret travels exactly as before. The eye only changes how the field is drawn on your own screen. Nothing new is sent, stored or logged, and the link still works once and still expires.

## What the reader needs to decide

Nothing. It is a small display change to one form, and reverting the commit undoes it completely.
