
## Closing the database on exit

The meaning search keeps a small database of its own. Instar keeps a list of every database that must be closed cleanly when the agent stops, and a test checks that no database is left off it. The meaning search database already joined the list, but the test's own record of databases did not name it yet, so the test failed. The record now names it.
