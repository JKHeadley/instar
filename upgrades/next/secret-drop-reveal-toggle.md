## What Changed
Secret Drop forms now have a show/hide eye button on every masked field, so the person can check what they typed before sending. Sending the form hides the field again first. The secret is sent, stored and expired exactly as before.

## What to Tell Your User
When I send you a secure link for a password or key, you can now tap the eye in the field to check what you typed before sending it.

## Summary of New Capabilities
- An eye button on Secret Drop secret fields shows or hides what was typed.

## Evidence
tests/unit/SecretDrop.test.ts renders the real form in jsdom. It taps the eye to show and hide a masked field, checks that unmasked fields get no eye, checks that submitting re-masks a revealed field, and checks that the field name is escaped inside the new button's attributes.
