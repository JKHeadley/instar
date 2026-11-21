# Self-updater builds its database binding for the Node that will run it — Plain-English Overview

> The one-line version: when the agent installs an update, the small piece of compiled code that lets it use its SQLite database is now built by, and for, the same copy of Node that will run the agent, instead of whatever copy of Node happens to be first on the machine's search path.

## The problem in one breath

An instar agent updates itself: it downloads the new version into a side folder, builds one compiled dependency (the SQLite driver, `better-sqlite3`), checks that the new version starts and can open a database, and only then switches over. The build step ran the `npm` command from the machine's search path. `npm` is a script that starts with "run me with `node`", so it used the first `node` on that path. On the Mac Studio that was Homebrew's Node 22, while the agent itself runs its own private Node 24. Compiled code built for Node 22 cannot be loaded by Node 24 (the two have different internal interfaces, numbered 127 and 137), so the check failed every time, the update was kept back, and the Studio stayed on version 1.3.1944 while every other machine moved on. This happened on 2026-11-20 and 2026-11-21 for every version since 1.3.1944.

## What already exists

- **The side-folder update** — the new version is installed next to the running one and promoted only after it proves it can start. This stayed correct: it refused the broken build, which is why the agent kept running. It just could never accept a good build.
- **The validator** — the check that starts the new version and opens a database. It already uses the agent's own Node (a link at `.instar/bin/node`, or the Node running the server). That was the right binary; the build step simply did not use the same one.
- **The request time limit** — the web server answers "took too long" after 30 seconds on most requests. The "apply the update now" request runs for minutes, so the server sent that 30-second answer, and when the real answer arrived later it was logged as a duplicate and dropped.

## What this adds

The build step now runs under the same Node the validator uses. Concretely, the updater:

- finds the agent's runtime Node (the same lookup the validator does),
- runs that Node's own bundled copy of `npm` with that Node, rather than asking the search path for `npm`,
- puts that Node's folder first on the search path for the build, so the build tools that look up a bare `node` find the right one too,
- tells the build tools where that Node's header files live (when the Node install ships them), so they build against the right version without a download,
- and if the runtime Node ships no `npm` of its own, falls back to `npm` from the search path — still with the runtime Node's folder placed first — and writes a line in the log saying it did so.

The "apply the update now" request also gets a 15-minute time limit of its own, so the server no longer answers "took too long" at 30 seconds and then drops the real answer.

## The safeguards

**Nothing new decides anything.** The updater still accepts an update only when the validator says the new version starts and can open a database. This change only makes the build target the right Node; a wrong build is still refused exactly as before.

**The fallback is loud, not silent.** When the runtime Node has no `npm` beside it, the log says so in plain words and names the Node it used. Nothing is hidden.

**Rollback uses the same path.** Rolling back to a previous version rebuilds the same dependency; it goes through the same runtime-Node invocation, so a rollback cannot reintroduce the mismatch.

**Tests pin both shapes.** One test puts a fake "other" Node first on the search path and checks that the build is invoked with the runtime Node, its folder first on the path, and the header location set. A second checks the fallback and its log line. A third checks rollback. All three fail against the previous code.

## What ships when

One pull request: the updater change, the request time limit, and the tests. It takes effect on each machine the next time that machine takes an update — which, on the Studio, is the first update it has been able to take since 1.3.1944.

## What you actually need to decide

Nothing beyond merging: this is a narrow bug fix with no setting, no new behavior to turn on, and a revert fully undoes it.
