# ELI16 — why tests were filling the Mac's Accessibility list, and the fix

Macs keep a list of programs allowed to control the computer (Accessibility) and to see the screen (Screen Recording). The list remembers each program by where it sits on disk. Instar's remote-desktop helper is one such program, and the one that matters lives in a fixed place in your home folder.

Our automated tests started the real helper too. They ran it from a fresh copy of the code each time, often a throwaway copy used to check a pull request. Each copy sits somewhere new on disk, so each test run added another "instar-desktop-host" line to the list, all switched off. One test even asked macOS for permission, which made pop-ups appear on the screen of the person using that Mac. On the Mac Studio this produced dozens of lines and kept adding more after Justin removed them.

The fix has two parts. First, the code that starts the helper now refuses to start the real one when it is running inside the test tool, unless someone sets a specific switch meaning "this Mac is set aside for these tests". Second, the handful of tests that genuinely need the real helper now run only with that switch on. Tests that use a pretend helper, which is most of them, keep running as before.

Nothing changes for an agent running normally: the check only applies inside the test tool. The old lines already on a Mac stay until someone removes them with the minus button. The one at ~/.instar/desktop-helper/instar-desktop-host must stay on.

The decision for a reader: whether real-helper tests should ever run on an operator's everyday Mac. This change says no, by default.

One small fix came with it: the page that reports whether locked-screen access is set up now answers "cannot read it here" straight away when the helper cannot be checked, instead of waiting until the request times out.
