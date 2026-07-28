# Auto-Updater Deferral Retry Recovery — ELI16

Imagine an update is downloaded, but Instar waits to restart because someone is
still working. It writes down “try again in five minutes” and also sets an alarm.
Previously, the note survived, but the alarm did not. If the alarm disappeared,
Instar kept seeing that the update was already downloaded and never set another
alarm. It could run the old code for hours after the work ended.

Now Instar rebuilds the alarm from the saved note whenever it starts. Every
regular update check also makes sure the alarm still exists. If one retry itself
fails, another retry is scheduled. Active work is still protected; this only
prevents a lost alarm from turning a temporary wait into a permanent one.

The activity decision itself is unchanged. Instar still asks its existing
session-health gate whether real work is active, so this fix does not invent a
second definition of “idle.” It repairs the delivery mechanism around that
decision: the saved deadline is the durable truth, the timer is replaceable
machinery, regular checks verify the machinery remains attached, and stopping
the updater invalidates older callbacks so they cannot quietly re-arm later.
