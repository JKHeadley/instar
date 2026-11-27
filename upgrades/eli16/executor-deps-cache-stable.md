# Not rebuilding everything after every release

Feedback workers run in a locked-down space with their own private copy of the project's dependencies. Building that copy includes compiling a database module, so it's kept in a cache and reused until the dependencies change.

To spot a change, the system fingerprinted two files, package.json and package-lock.json. The catch: every release writes the new version number into both files. No dependency changed, but the fingerprint did, so every release threw the cache away, and we release about hourly. The rebuild normally takes about a minute, but two attempts tonight ended when it hit its 20-minute limit. We don't know what hung, because nothing was captured, so this avoids that step rather than explaining it.

Now the fingerprint ignores the project's own version number, so a release keeps the cache. If a dependency really does change, the fingerprint still changes and a new copy gets built, but the compiled database module is reused from an earlier copy when it's the same module version built for the same version of Node. One safety check depends on that fingerprint: a base lint and test run that catches a broken main branch before a report gets blamed for it. That check still runs for every release. Nobody has a decision to make, and undoing this is a plain revert.
