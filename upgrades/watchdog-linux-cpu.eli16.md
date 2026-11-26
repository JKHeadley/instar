# Watchdog test on Linux — the plain-English version

The watchdog watches for commands that look stuck and interrupts them. Yesterday's change taught it to leave a long test run alone as long as the run is still using CPU. An end-to-end test proves that with a real `npm test` process.

On GitHub's Linux machines that test sometimes failed: the watchdog asked its "is this stuck?" judge about the test run, which it should never do for a run that is still working. Justin's fix this morning (#2298) made the test start a real vitest process, which the watchdog always recognises, and that fixes it. But the explanation written into the test was wrong.

What actually happens: on Linux, npm renames its own process as it starts. For about a second it shows up as just "npm", and only then as "npm test". The test looked at the process list during that first second, saw plain "npm", which on its own does not look like a test run, and the check went down the wrong path. macOS always shows the full original command, so it never failed there.

The real watchdog is not affected: it never judges anything younger than three minutes, and by then the name always says "npm test". This change makes the test wait until the process looks like a test run the same way the watchdog checks, fixes the explanation, and adds small tests for both the macOS and Linux shapes of the process name. Nothing changes for users.
