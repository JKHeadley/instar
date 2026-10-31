# Fair turns for merge checks and other full test runs

## The problem

Studio runs one large test suite at a time. That limit protects the machine from a test storm, but it also means a long suite started for another project task can hold up the test of Instar's newest code. Once the slot opens, several other waiting suites may be old enough to go ahead of the merge check. The current rule was introduced for a good reason: earlier, ordinary test runs could wait forever behind a steady stream of merge checks. We need both kinds of work to move.

## What changes

When a merge check is actually trying to get a slot and an ordinary suite has waited at least 15 minutes, they take turns. If an ordinary suite got the last free slot, the merge check is offered the next one. If its process pauses, the offer expires after twelve seconds, then the merge check and an aged ordinary suite race on their next polls. If a merge check got the last slot, the oldest aged ordinary suite gets the next. A reservation without a merge test process does not create a new delay for aged ordinary work. The rule is applied when a slot becomes free; it leaves a running test alone. It requires Studio's one-slot limiter to be enforcing.

The machine keeps a tiny local record of which kind got the last slot inside the same file that records active test slots. Every updated test process uses the same lock when it reads that record and claims a slot. If the record is missing or damaged, the machine uses today's rule, so a record problem cannot stop tests. An older test process can erase the record or preserve an outdated copy. A separate file-write proof detects either rewrite under the shared locking contract; the updated process then uses the old scheduling rule until a fresh admission rebuilds valid history. If the limiter fails open while its disk cannot be written, no file can prove that invisible test happened, so the fairness claim excludes that period. A status view will show whether the new rule is active and what it currently predicts, with an explicit unknown when the information is incomplete.

## How it goes live

This starts switched off. It is rehearsed on an isolated test agent, then observed on Studio before enforcement. If the record stays coherent and the single-slot limit holds, we turn it on there. One switch turns it back off if it causes trouble. Mini and M5 keep their existing behavior until separately tested.

This change improves the waiting line when both kinds have active waiters. It cannot make a suite already running finish sooner; an ordinary waiter can time out after 45 minutes and lose its place. We will measure those timeouts and retries separately. A PR still needs a clean full verification before merge. We will report both merge-check waiting time and ordinary test waiting time.
