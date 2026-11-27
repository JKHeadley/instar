# Side-effects review for closing an app conversation after transfer

The binding pass waits up to ten seconds for an asynchronous close to return before moving to the next lost conversation. The outstanding close remains tracked by session incarnation until it settles. Further reconciliation can consider other sessions while that operation is unresolved.

The close implementation must call the provided authorization check immediately before a durable or irreversible action. Production calls it directly before the existing termination authority. The callback checks the monotonic deadline, current pool, service generation, live conversation, session identity, and current ownership or signed lease. It checks the deadline again after those reads. The production termination authority performs the write and bounded local process kill in the same synchronous turn.

The deadline bounds asynchronous waits while the event loop can run. The existing synchronous kill uses its own transport timeout. An unresolved operation delays retrying that same session incarnation, which avoids dispatching another close while the earlier operation is still pending. A changed incarnation receives a fresh decision.

The tests cover new ownership while liveness is pending, a close that does not return, late commit refusal, session-level deduplication, and an authority check that crosses the deadline. The production wiring test pins the authorization check before the termination call.
