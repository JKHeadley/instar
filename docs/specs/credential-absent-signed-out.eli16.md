## Noticing an account whose sign-in is completely gone

Instar checks each AI account every few minutes. When an account's saved sign-in has disappeared entirely, it used to say "can't tell" and leave the account marked as working. It did that on purpose: after a Mac restarts, its password store is locked, and a perfectly good sign-in looks missing until someone logs in. So the automatic repair never started for a sign-in that was really gone, and the account sat broken while looking fine.

Now, when the saved sign-in is missing, Instar asks Claude itself whether that account is signed in, and checks that the Mac's password store is actually unlocked. If Claude says "signed out" while the store is unlocked, and says it again at least five minutes later, the account is marked as needing sign-in and the automatic repair starts. If the store is locked, or Claude can't answer, nothing changes.
