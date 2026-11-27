# Independent review of the Mini verifier start gate

Reviewed base `8271e96d4c3a7bc3a304c446fc5a51ea7159e030` and exact candidate `129a42c7c29cb5a30fa23f6d48f594b82ee3efcc` for PR 3876. I authored neither the implementation nor its fixtures.

The optional signed policy adds a stricter start floor. It retains the existing single sample for policies without that field. An opted-in run needs four fresh normal-pressure samples and refuses a low sample or stale interval. The runtime floor, reserve, test assertions and verdict conditions are preserved.

The original review found that diagnosis could start during sampling. The successor accounts for the reservation in the shared diagnosis busy predicate, which the diagnosis service checks before and after its asynchronous admission checks. Full verification rechecks active diagnosis after sampling and refuses before spawn. The new interleaving regression holds sampling open, asserts the reservation, then simulates active diagnosis and requires refusal and zero spawns. The remaining tests preserve existing assertions.

## Second-pass review

**Reviewer:** echo topic 147616, independent reviewer

Concur for the exact candidate. Throughput reported 156 focused tests and all 55 lint steps passed. Native SQLite was unavailable in that focused checkout. Full shared verification of the successor and the existing Mini quarantine remain in effect.
