# Give local test discovery time to finish

Before a push, Instar works out which tests the change might affect. On the Studio this took longer than two minutes even on fairly small changes. The push stopped before it could select a test. This change gives each discovery step up to six minutes. A failed discovery still stops the local check, and the full shared verification remains required for merge. This is a stopgap while we make test selection faster.

Discovery follows the files that import the changed code. A small change can still reach a large part of the project when it touches a common module. When the list is complete and too large for a quick local check, the existing broad-change rule leaves testing to the full shared run. When the list is incomplete, the tool keeps showing a failure so the developer knows no tests were selected.

The change does not select more tests or alter which results allow a merge. Developers can still use the existing timeout setting when they need a shorter or longer deadline on their machine.
