# Signing an account in from your phone with Face ID — the plain version

## What this is

When one of your subscription accounts needs signing in on one of your machines, the Instar app has
a "Sign in" button. Today that button asks you to type the dashboard PIN. Everywhere else in the app
(approving a request, turning a switch on or off, moving a conversation), you just look at the phone
and Face ID confirms it is you. Justin asked for the sign-in button to work the same way. This change
adds the server side of that: a new address the app can call with a Face ID proof instead of the PIN.

## What already exists

Two things, both already trusted:

1. The dashboard's "start a sign-in" step. Given the PIN, it checks that account sign-in is switched
   on, makes a short-lived written permission for that one account on that one machine, and starts the
   sign-in, handing back the page to open. If a sign-in is already waiting for that account it hands
   that one back instead of starting a second.
2. The app's Face ID check. The phone asks the agent for a one-time code tied to the exact thing you
   are about to do, you look at the phone, and the phone's secure chip signs "this exact action, with
   this code". Only the owner's own paired phone can do this; a teammate's phone cannot, and neither
   can the agent itself.

## What is new

A new route that does the Face ID check for "sign in account X on machine Y" and then runs the very
same start-a-sign-in code the PIN route runs. Nothing is copied: the PIN route and the new route now
call one shared piece of code, so they cannot drift apart. The answer the phone gets back is exactly
the one the app already knows how to read.

## The safeguards, in plain terms

- Only the owner's phone. Team members' phones and the agent's own key are refused.
- The Face ID proof names the exact account and the exact machine. A proof for one account cannot be
  reused to start another account, or the same account on a different machine. Each proof works once.
- The account and machine names must be in the exact shape the agent uses, so nothing odd can be
  smuggled into what gets signed.
- Every attempt, allowed or refused, is written to the phone actions log.
- The same safety checks the dashboard route has (accounts list readable, identity checks finished,
  feature on) run here too, in the same order.

## What stays the same

The dashboard still uses the PIN. Older versions of the app still use the PIN. No settings, stored
data or migrations change. Undoing it is just removing the route.

## What you need to decide

Nothing beyond the request itself: this follows the existing rule that a Face ID proof stands in for
the PIN on owner actions. The app needs its own small update to use the new route.

**Fix after testing (2026-11-10):** the phone has a speed limit for Face ID actions. Starting a sign-in shared one limit with the other Face ID switches, so after a dozen of those in a minute a sign-in was refused with "too many requests". Sign-ins now have their own limit of 12 a minute, and adding an account will share it.
