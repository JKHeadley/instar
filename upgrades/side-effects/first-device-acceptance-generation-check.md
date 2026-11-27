# First-device acceptance generation check

The existing local first-device path captures the trust store's acceptance key before asynchronous eligibility checks. The store rejects a changed key or an occupied slot, and reserves the exact key before awaiting persistence through the existing writer. Existing nominated-device and local override writes keep their current keys and checks.

The regression test saves a slot key, accepts and withdraws a device, then verifies that the old key cannot write into the now-empty slot. The existing concurrent-candidate test continues to check that only one local candidate wins. The focused file passed all 48 tests.

This checkpoint adds no remote caller, changes no eligibility rules, and grants no cross-process fencing. The phone flow remains dormant. Reverting this change restores the prior local acceptance behavior without changing persisted record formats.

Independent review concurred on the generation check and the pending same-key race.
