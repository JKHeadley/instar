# Restarting for an update as soon as the test run ends — plain-English overview

When a new Instar version arrives, the server needs to restart to use it. If a pull request is being tested at that moment, the restart waits for the test to finish, and no new test starts in the meantime (otherwise a busy line could hold the update off forever).

The problem was the timing. The updater only checked whether it could restart every 5 minutes. So after the test finished, the line could sit empty for up to 5 minutes: no test running, and no restart either. Last week that happened 35 times, about 3.3 hours in total.

Now, the moment a test run ends, the updater is told and checks right away. If nothing else is holding the restart, it goes ahead within a second, and the test line starts again after the restart. Anything else that normally delays a restart (people's sessions, the restart window) still delays it exactly as before.

What you need to decide: nothing.
