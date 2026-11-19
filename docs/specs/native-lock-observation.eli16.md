# Measure whether a relock guard issued a lock command

The account-switch and logout proofs must show that Instar did not send a lock command against another login session. Seeing a closed duty or no running process cannot prove that. A guard could have acted and disappeared between observations.

Each proof server now keeps a small lifetime list of guard spawn attempts, recorded before starting the child. The native guard receives that attempt identity and counts real lock dispatches in memory. Its normal watch start and clean end save matching witnesses in the existing duty record. Counting adds no file access or permission decision before locking. If measurement fails, the safety action still runs and the proof becomes incomplete.

The proof requires the two original server histories, a positive watch checkpoint before the person leaves, a matching native final count, and a confirmed exit from that exact child. Both final histories are read after the person returns. Only a complete zero difference can establish zero dispatches. A crash, extra guard, missing witness, history overflow or server restart cannot pass. Logout that kills the guard before its clean witness remains unmeasured.

The test must run in a trusted, isolated proof account with only the two known proof servers. The new command-line assertion records that setup prerequisite; it does not establish isolation by itself. Unknown or surviving old guards refuse the measurement.

These diagnostics neither enable locked-screen access nor prove that a live Mac passed. The native source change requires the normal helper rebuild and permission-validation process before hardware proof. No installation or permission action is part of this change.
