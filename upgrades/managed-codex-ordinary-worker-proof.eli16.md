# Save the identity of a project worker

A worker can keep running after the server restarts. The server already saves a hold before starting an ordinary round worker. It can now add the worker’s process number and observed start time to that same hold. This helps a restarted server tell whether a process with that number is still the old worker.

If the worker exits quickly or the server cannot read its start time, the hold stays in place until there is stronger evidence. The data update preserves any holds saved by earlier versions. Tests cover loading an earlier database, binding the worker once, and keeping the saved identity when the worker’s exit is uncertain. This change records the evidence in the test composition. The production launcher and restart recovery still need to use it before the server can safely clear old holds.
