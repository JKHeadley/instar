<!-- bump: patch -->
## What Changed

Windows Remote Desktop now detects a locked PC. The Windows companion reads Windows' session lock flag and the sign-in screen process; when both say locked, the probe reports `screenLocked`, the machine shows as unavailable with "This Windows PC is locked. Remote desktop cannot unlock Windows yet: sign in at the PC, then tap Retry.", and a session that is running ends as soon as the PC locks. Before, a locked PC showed as ready, the first click lifted the lock picture, the screen went blank and the session closed with no reason. Windows machines also get their own unavailable wording instead of the Mac text, the setup guide says "Unlock <PC>" for a locked Windows PC, and the web viewer shows the ended machine's own reason when a session cannot resume.

## What to Tell Your User

If you open Remote Desktop to a Windows PC that is locked, it now tells you the PC is locked and to sign in at the PC, instead of showing a blank screen and closing. Unlocking Windows from Remote Desktop is not possible yet.

## Summary of New Capabilities

- Windows Remote Desktop recognizes a locked PC and says so in plain words.

## Evidence

Reproduced on Mama PC (locked): click at 5.3 s, empty frames at 6.1 s, session ended at 7.4 s. With the fix installed on Mama: the probe reports locked, a start is refused, and the real Remote Desktop page on the Studio lists Mama with the locked sentence (checked at 1280x728 and 390x844). Unit tests cover the companion lock reading, host mapping, reason wording, setup guide and viewer.
