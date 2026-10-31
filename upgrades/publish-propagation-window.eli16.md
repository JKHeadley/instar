# Give npm time to show a published package

Instar's release check publishes a package, then installs it from npm to confirm it works. npm accepted versions 1.3.1528 and 1.3.1529, but neither appeared in the registry before the check's 15-minute deadline. The check reported a failed release even though publication had succeeded, leaving the version update out of the repository.

The check now retries for up to 45 minutes and prints a progress line about once a minute. It still fails if the package never appears or if a clean install cannot run and report the expected version. This changes the waiting period after a successful publish; it does not weaken the package test.

Each registry lookup has its own 15-second timeout. If a lookup hangs or returns a temporary error, the check tries again until the overall deadline. This keeps one slow network request from trapping the release job indefinitely. A genuine missing package still produces a clear failure after the deadline, while a package that becomes available proceeds through the same installation test as before.
