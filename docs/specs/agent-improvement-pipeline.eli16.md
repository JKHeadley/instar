# Agent improvement pipeline — Plain-English overview

An agent should treat a user correction as a chance to fix its own behavior and, when the lesson applies broadly, improve Instar for other agents too. Today Echo has pieces of that path, but two real corrections exposed places where the chain stops.

Echo noticed the request to stop asking users to inspect logs. At the same moment, the system was reducing background work because it was busy, so it discarded the correction before saving it. Echo later noticed the request for a built-in improvement pipeline and saved that one. It reviewed the request, but did not create a work item because the review system counted more than 100 open review records against a limit of 50, even though only one actual work item had been created. The limit was meant for work items, not for the records that say a review happened.

The first repair in this change saves a detected correction in the existing small, private retry queue when the system is busy. The queue expires old text on its maintenance timer even if the language model is still unavailable. When capacity returns, the normal review path can process the correction. The repair also makes the limit count real work items and prevents one review from using more slots than remain. If work is held at that limit, the system raises a coalesced attention item. These changes do not grant an agent permission to change policy. They preserve and route signals through existing review rules.

The larger pipeline is recorded in the companion technical plan. It still needs a recovery pass for reviews held when the work queue is full, a clear decision about whether a correction is local or applies to Instar generally, linked work items for both destinations, and checks that prove the fixes are live. The first repair makes the input and capacity accounting trustworthy; it does not claim that the whole improvement pipeline is finished.

The decision for this first repair is whether preserving busy-time corrections and counting actual work items are the right initial changes. Both are reversible code changes, and unit, HTTP, and production-path tests cover the observed failures.
