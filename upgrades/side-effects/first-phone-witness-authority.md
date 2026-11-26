# First-phone compound witness integration

This unmounted adapter connects the paired-phone decision handler to the shared witness store. The accepted floor and exact slot lineage are checked before the durable transaction. The observer may stage evidence. It cannot accept the decision or advance the floor. After observation the adapter rechecks the current attempt and floor and submits only the exact unchanged candidate.

Confirmation claims the shared first-approver slot and terminates the attempt in one witnessed write. Cancellation terminates its attempt without claiming the slot. Recovering an existing receipt requires the exact original candidate and does not advance the slot or floor. An unknown floor, uncertain observation or conflicting result leaves the attempt pending.

The integration uses a disposable witness database and synthetic signer. There are no new endpoints, production signers, configuration changes, or registry writes. A live test needs a deployed observer, durable exact-candidate retention and a registry projector that conditionally publishes the accepted projection against the live generation and head. The installed phone key still needs affirmative Face ID eligibility.

The witness now retains the staged candidate bytes before it can accept a first-phone decision. On historical lookup the adapter requires those same accepted bytes as well as the exact receipt. Missing staging or changed bytes leave the result pending. The injected observer is still used only in isolation.
