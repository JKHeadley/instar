# Managed continuation uses the right run record

When a managed Codex worker ends a turn, the installed hook asks the server whether that worker may continue. It does this even when an older run left an active record for the same topic. An emergency stop still lets the worker exit immediately. Existing installations with the previous stock hook receive the update. No project is enrolled or enabled by this change.

A project can have a new worker while a file from a previous autonomous run still exists. The previous file used to take precedence. That could stop the new worker too soon or give it the old run's instructions. The new order makes the active worker's recorded enrollment determine which rules apply. The server still checks that the worker owns the work and may continue before asking it to start another turn.

The change is ready for the next disabled-by-default build. The production launch still needs to establish current ownership and prevent an ordinary round and a managed worker from starting the same work. The tests cover both server decisions, emergency stop, and the update from the previous installed hook.
