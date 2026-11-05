# ELI16: which account's password box counts, and a crash test that really crashes

The Mac helper asks macOS "is someone typing into a protected password box?" before it will type a password into the lock screen. macOS answers with a list, one row per logged-in account, and the helper took the first answer it found in any row. On a Mac with two accounts logged in, a password box open in the account that is NOT on screen could make the helper refuse a real lock screen, or treat an unlocked screen as if it were locked. Now it only reads the row of the account on screen. If no account is on screen (the login window) it still reads every row, as before.

The second fix is in the test rig. One crash test was meant to have macOS's service manager (launchd) kill the server, but the test machine has no such service, so the kill hit nothing and the test could still pass. Now the test first moves the server under launchd, kills it for real, and fails loudly if nothing died. Afterwards it puts the server back.

We fix both before the proof because a helper change after the proof would need new Mac permissions and a new proof.
