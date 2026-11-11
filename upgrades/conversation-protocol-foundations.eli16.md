## What Changed

This is a prerequisite for Conversations. It adds the internal rules used to check saved records, identify the machines that belong to the agent, and protect the keys needed for recovery. The visible feature is still being built. This change by itself does not turn it on or complete a recovery.

When recovery is needed, the agent must tell apart a real owner decision, a record signed by a known machine, and data that was actually saved. Those are different facts. These rules check the record and its signatures. The working service must still check the current owner and machine state before making a change. An old signed record is not fresh permission to remove a machine.

Recovery keys are sealed for the exact machines named in the signed membership. A different machine or a substituted key cannot open the same envelope. Public recovery records contain identifiers and commitments to the saved work, rather than effort names or private messages. They do not publish the private key used by the storage service.

There is also an explicitly selected durable path for recording a native machine revocation. It writes a recovery journal first, then finishes the related identity and audit files. If that work is interrupted, it resumes the same recorded transaction. Importing the new rules removes no machine. The ordinary identity-management path keeps its existing behavior.

No outside service or new setting is required by this prerequisite. Conversations still needs its complete app, storage, restart, privacy and release checks before deployment. The change makes no promise that all backups have been erased or that every possible machine failure is already covered.

## Evidence

Focused tests use real cryptographic keys and signatures to reject changed membership, recipient and owner data, invalid consent and malformed records. Native identity tests interrupt journaled revocation at each write boundary and test a failed first disk barrier. The isolated prerequisite copy also compiles without the unfinished runtime modules. These component checks are not a deployed feature, a fresh human-admission test or a full multi-machine recovery proof.
