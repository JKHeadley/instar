# Apprenticeship registry integrity — ELI16

Think of the apprenticeship registry as the official class roster, and cycles as graded assignments. Previously, the assignment recorder checked that a student name was written down, but it did not check the roster. That allowed an assignment to be filed for a student who did not exist.

Cycle recording now resolves the instance in the live registry and accepts it only while that instance is `active`. `pending` means work has not started, `blocked` means work is paused, and `complete` or `abandoned` means the history is closed. Recording new work in any of those states would make the timeline lie.

A mis-created `pending` instance can now move to terminal `abandoned`. It is retained rather than deleted, so the audit trail says that the record existed and was intentionally retired. `abandoned` is legal only from `pending`; an active instance must use the existing blocked or complete lifecycle instead.

Old cycle rows are not silently repaired or deleted. `GET /apprenticeship/cycles/integrity` scans the stored rows and reports cycle IDs whose instance IDs no longer resolve. That gives operators honest visibility without inventing registry history.

## ELI16 — why active-only?

A cycle is evidence that apprenticeship work actually happened. Allowing it before start, during a pause, or after a terminal state would weaken the meaning of both the registry state and the cycle timestamp. Active-only makes the two records agree.
