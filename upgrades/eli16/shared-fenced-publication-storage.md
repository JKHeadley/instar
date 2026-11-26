# Let only the current holder claim a saved operation

Several Instar workflows need to save an operation once and have the right machine carry it out, even when responsibility changes between machines. This checkpoint gives those workflows a common way to record a claim. Each workflow has its own records. The store checks the holder and generation in the same transaction that records the exact claim. If a handover is pending, neither holder can claim new work. If the acknowledgement gets lost and the request comes back, the store can recover the earlier claim without granting permission to run it twice.

This is the storage part of the shared authority. It runs against one database and does not change the app, delete actions, Needs-you, or machine-key history. Before using it live, the receiving service must verify the machine and the handover proof and reject older restored state.
