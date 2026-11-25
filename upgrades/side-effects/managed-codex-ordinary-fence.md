# Side-effects review for durable ordinary round fences

The ordinary executor saves an execution fence for the round and all items in the same transaction before starting a child. The managed reservation checks that scope using the shared store, so replacing every item cannot bypass an ordinary fence. Ordinary launch likewise refuses a managed claim on the same round. The fence survives reopening the database.

The local execution path settles only its exact identifier after confirmed non-start or an absent Unix process group. Unconfirmed termination holds the fence and stops relaunch. An absent group does not establish the fate of a process that detached from it. Recovery does not automatically clear stale persisted fences. Production needs a mandatory common store, worker recovery evidence and a policy for preexisting records without a round key. No production activation or flag change is included.

## Second-pass review

**Reviewer:** ordinary_fence_review, independent Instar second-pass agent

Concur with the revised dark fixture. Both immediate reservations include the canonical round scope. A changed item set cannot bypass an old fence. Settlement is specific to one execution and uncertain termination cannot relaunch the round.

## Class-Closure Declaration

The added reservation and settlement are one-shot writes attached to an existing launch attempt. They create no unbounded-self-action. An uncertain worker stops the existing relaunch loop. The fixture provider has no production caller.
