# Run useful local tests before a full shared check

Before publishing a change, the computer tries to run a small set of relevant tests. When a change touches the verifier, the old search follows links through the shared web server into hundreds of unrelated parts of the project. On one 21-file change it found 1,084 test files. The list took minutes, and it was too large to run as a quick check.

For a change that stays inside the verifier, the local check now looks first at tests that use the changed code directly. It also includes tests changed alongside the code and the tests that check how the verifier connects to the server and helper machines. A change that crosses into other parts of the project uses the existing wider search. The full shared test run still checks everything before a merge. This change makes the small local check more likely to run useful tests while that full result is pending.

The push output tells you how long it took to choose tests and how many it picked. That makes it easier to tell a slow search from slow tests.
