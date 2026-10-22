# Parallel test lanes — the plain-English version

Instar's tests come in three groups: unit tests (small checks of one piece of code), integration tests (several pieces working together over the server's web interface), and end-to-end tests (the whole agent started the way it really starts). The command that runs everything, `npm run test:all`, runs the three groups one after another.

Two things made that slow. First, the unit-test settings also picked up every integration and end-to-end test file, so a full run ran those two groups twice. Second, every test file ran one after another, even the unit tests, which do not get in each other's way.

This change fixes both. The unit-test settings now pick up only unit tests, so each file runs once. Unit test files now run 8 at a time on a machine with 12 or more cores (half the cores on a smaller machine; the `INSTAR_TEST_WORKERS` setting overrides it). Integration and end-to-end tests still run one file at a time, because two known clashes (shared network ports and shared terminal sessions) make them unsafe to run together yet; each has its own follow-up fix. The end-to-end settings now build the program first, because they used to rely on the unit-test run having done it.

Measured on the Mac Studio with this change: unit tests 4 minutes (2,694 files, all passing), integration 15 minutes, end-to-end 24 minutes. A full run is about 43 minutes, with nothing running twice.

Nothing changes for agents or users. This is the first piece of the approved local-verify design, which lets merges wait on a local test run instead of GitHub's queue. To undo it, set `INSTAR_TEST_WORKERS=1` to go back to one file at a time, or revert the change.
