# Verifying What Each Trial Received

A replay must show that the answer belongs to the planned trial and that the answering model received the planned input. The offline validator checks consistency within a supplied capture. A capture can pass that check even if someone replaced its sources and recalculated their digests together.

## Freeze the trial before collecting answers

The evaluation host records the plan and keeps its SHA-256 digest in a trusted evaluation record. The plan identifies the evaluation, case, submission, comparison arm and repeat. It records the exact request digest, original-source digests, ordered sources available to the answer producer, rubric digest, required judge slots, retry limits and schema and harness versions.

The host verifies the plan against the digest it retained before collection. An importer may supply a plan for inspection. Only the independently retained digest establishes which plan was frozen. The answer producer receives its scheduled request and cannot read the plan, rubric, other arms or judge records.

## Record what crossed each delivery boundary

For each answering attempt, the host records the digest of the request that was actually delivered, its trial and attempt identifiers, terminal status and the digest of the exact output bytes if any. The judge receipt uses the same approach and binds the delivered request to the answer attempt identifier, answer digest, rubric and judge slot. The host records family and independence evidence from the route used for the call.

An input measured before a route appends instructions or tool results establishes only what the host submitted. Record the gap and keep that trial exploratory. If a route supports additional exchanges during the attempt, evidence must cover the full ordered sequence delivered to the model, with an explicit position, direction, role and byte digest for each exchange. Hash original bytes before parsing or normalizing them. Keep the originals and receipts under restricted custody.

## Check binding before grading

Join by host-issued identifiers and verify the plan, delivery receipts and raw payloads. Look up receipts in the host-owned record or verify their authentication against a trusted host identity. Treat a missing submission receipt or any contradiction as an import failure. When submission binding is valid and only the model delivery evidence is missing, keep the trial exploratory. Keep a scheduled omission visible and retain every attempt, including failed, duplicate and late attempts. Attempt status and the frozen retry policy determine which receipt fills a slot. Preserve an invalid answer as a failed answer and an invalid judge response as a judge error when the binding is established.

Binding establishes consistency with the host's records. Source authenticity, isolation of reference answers, independence of judges and semantic correctness each require their own evidence. Public reports use aggregate counts and reasons without private content or identifiers.

## Acceptance examples for a future implementation

| Fixture | Expected result |
| --- | --- |
| Matching frozen plan, delivered requests, outputs and judge receipts | Proceed to structural validation. No semantic pass follows from binding alone. |
| A different arm or repeat, or two valid answers exchanged between submissions | Record a binding failure for each mismatch. |
| Replacement plan and matching checksum supplied together by an importer | Reject the plan when its digest differs from the retained host digest. |
| Source bytes and their capture digests replaced together, or a withheld source added | Reject the changed source manifest or availability list against the frozen plan. |
| Planned request matches, but delivery evidence is absent or omits route-injected content | Keep the result exploratory and report the missing delivery evidence. |
| Rubric changed after capture or judge receipt copied from another answer, including one with identical bytes | Record a binding failure and retain the original receipt. |
| Importer replaces an output and provides a matching receipt it created | Reject the receipt and preserve the import failure. |
| Delivery receipt drops, reorders or inserts an exchange | Reject a contradicted sequence. If the route simply cannot provide complete evidence, apply the exploratory rule only with valid submission binding. |
| Submission receipt missing, or a delivered digest contradicts the planned digest | Record a binding failure. |
| Omitted judge slot or duplicate attempt identifier | Preserve the omitted slot or duplicate records and report incomplete evidence. |
| Bound timeout followed by a permitted retry | Keep the timeout and its cost. Let a valid retry fill only the original slot. |
| Bound answer or judge output is malformed | Preserve the failed answer or judge error and retain the raw capture. |

These are synthetic design examples. This document runs no trials and grants no qualification.
