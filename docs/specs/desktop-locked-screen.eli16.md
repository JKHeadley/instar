# Remote desktop into locked machines — Plain-English Overview

> The one-line version: you will be able to open a locked Mac from your phone and type its password yourself. Instar never keeps that password, and it gives no agent one.

## The problem in one breath

Instar's remote desktop stops the moment a Mac locks, so you have to walk to the machine. AnyDesk does not have that problem, and you need it not to be a problem here either.

## What we found

"Locked" is really several situations. The everyday one, where you are logged in and the lock screen is showing, happens inside your own session. A login-screen helper does not run there at all. So the usual lock needs no powerful helper. Our existing helper has to stop refusing, and keep working through the lock.

The harder cases are the login window after a restart, logout or user switch. Those need a new helper that macOS starts before anyone logs in, and it runs as the top-level system user. AnyDesk, TeamViewer and RustDesk do this, and Apple's engineers confirmed the approach in January 2026. It also breaks often: AnyDesk's changelog shows login-screen fixes for most macOS releases.

No one can reach the FileVault screen shown before macOS starts, or a Mac fully asleep. From outside these look the same as a Mac at its login window, so Instar will say "offline: can't tell".

## What ships when

First, a test on a throwaway Mac user, to prove what macOS really allows. Then a better reading of whether a Mac is really locked, because the existing flag has been wrong before. Then the ordinary lock screen. The login-window helper is designed here but not committed: when real rescue attempts keep failing at login windows, Instar offers it, and you decide. A cheaper alternative also exists: on Macs without FileVault, macOS auto-login brings Instar back after a restart, though that Mac then sits logged in. Everything ships switched off, one machine at a time.

## Your password

You type it into a box that seals it so only the small helper on the Mac can read it. The helper types it once and wipes its copy. No setting, file or job can save it, and only a few tries are allowed so your account can't be locked out.

The honest limits: in a web browser, the machine serving the page, or hostile software running as you on that Mac, could read what you type. That password also opens your keychain. An iPhone sheet will close the tunnel gap when it ships, and with the login-window design also the serving-machine gap. The tunnel service carrying the page sits in that path too. The box hides itself unless the normal tunnel is working.

If someone unlocks at the very moment of typing, part of the password could land in an open app. The helper checks before every letter, which makes this unlikely but not impossible.

## Who can open a lock

The ordinary lock is protected by your Mac password, and that is the real barrier. Someone with a stolen dashboard PIN could see the lock screen but not get past it, and their session normally ends if you unlock at the Mac.

The login window gets more: you approve on your phone with Face ID, typing a code shown on the viewer. Neither the PIN nor a Telegram tap counts, because agents can reach both. A one-time recovery code covers a lost phone.

## The safeguards

- The Mac locks itself again when you finish, unless you tap Leave unlocked, even if Instar crashes. If a Mac can't prove it can do this, the password box doesn't appear.
- The login-window network piece runs as a limited account and only calls out. Nothing new listens on the network.
- macOS doesn't let anyone draw over the lock screen, so there is a chime at the start and a notice after you next unlock.
- Every use is logged, and any agent can turn the feature off.

## What it will cost you

The ordinary lock: one permission grant per Mac, which only a person can do because Apple requires it. The login window, if you choose it: one phone signature, one fingerprint match, one Mac password box, two System Settings switches, once per Mac, plus one sign-in by you to create Apple's signing certificate. macOS may ask you to reconfirm screen recording about monthly, unless Apple grants a special permission we will request.
