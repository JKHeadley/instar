# Remote desktop through the Mac lock screen — Plain-English Overview

> The one-line version: you will be able to open a locked Mac from the Instar app on your phone and type its password yourself. Instar never keeps that password, and it gives no agent one.

## The problem in one breath

Instar's remote desktop stops the moment a Mac locks, so you have to walk to the machine. AnyDesk does not have that problem, and you need it not to be a problem here either.

## What this covers

This covers the everyday lock: you are logged in and the lock screen is showing. That happens inside your own session, so nothing powerful needs installing. Our existing helper has to stop refusing and keep working through the lock.

It does not cover a Mac sitting at the login window after a restart, logout or user switch. That needs a much bigger helper running as the top-level system user. It is written up separately as an unapproved note and nothing here depends on it. No one can reach the FileVault screen before macOS starts, or a Mac fully asleep.

## Your password

On your phone you type it into a native sheet in the Instar app, inside the remote desktop screen the app already has. The app seals it so only the small helper on the Mac can read it. The helper types it once and wipes its copy. No setting, file or job can save it, and only a few tries are allowed so your account can't be locked out.

The app remembers each Mac's key the first time it sees it, and refuses the sheet if that key changes. The very first contact has to trust what the machine serving the app says, so that first time is the weak moment.

A password box in a web browser is off by default. The machine serving that page and the tunnel provider can both read what you type there, so you have to turn it on yourself, per Mac.

Hostile software already running as you on that Mac is not stopped by any of this. It could capture the password, which also opens your keychain.

If someone unlocks at the very moment of typing, part of the password could land in an open app. The helper checks before every letter, which makes this unlikely but not impossible.

## Who can open a lock

Your Mac password is the real barrier. Someone with a stolen dashboard PIN could see the lock screen and press its buttons, but not get past it, and their session normally ends if you unlock at the Mac.

## The safeguards

- The Mac locks itself again when you finish, unless you tap Leave unlocked, and this holds if Instar crashes. Instar then watches for 2 minutes, relocks if the Mac opens, blocks new connections while it watches, and tells you if the Mac ended up unlocked. So the promise is "relocks, and tells you if it couldn't". A very slow unlock past 2 minutes is a risk you accepted. If a Mac can't prove it can relock, the password option doesn't appear.
- macOS doesn't let anyone draw over the lock screen, so there is a chime at the start and a notice after you next unlock.
- Every use is logged, and any agent can turn the feature off.

## What it will cost you

One permission grant per Mac, which only a person can do because Apple requires it, and again when the small helper itself changes, unless we later get a stable signing certificate. We will test whether you can do that from your phone while the Mac is unlocked. If not, it is one sitting at each Mac. That conflicts with the rule that everything can be done from a phone, and only you can accept that or change the rule. macOS may also ask you to reconfirm screen recording about monthly.
