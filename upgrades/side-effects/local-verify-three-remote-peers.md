# Side-Effects Review — Local Verify can use three remote peers

**Version / slug:** local-verify-three-remote-peers  
**Date:** 2026-11-26  
**Author:** Echo  
**Second-pass reviewer:** peer_capacity_review

## Summary of the change

The coordinator reads up to three configured remote verifiers, for four machines including the coordinator. The verifier parser, operating instructions, and regression tests reflect the new bound.

## Decision-point inventory

- The peer configuration parser increases the number of valid configured remote verifiers it accepts from two to three.
- The dispatcher continues to check resource availability, lease ownership and epoch, verifier version, policy hash, signer pin, and existing reservations.
- The migration refreshes the shipped instruction for existing agents while preserving edits elsewhere on the line.

## 1. Over-block

A fourth valid remote entry stays outside the configured pool. Three entries cover the four-machine deployment, including the coordinator.

## 2. Under-block

A third entry that was already present in configuration becomes eligible at activation if it passes the normal dispatch checks. The operator can review configured entries on the coordinator before updating.

## 3. Level-of-abstraction fit

The existing parser owns the list bound. A single adjustment reaches both dispatcher and failed-file diagnosis callers.

## 4. Signal vs authority compliance

The parser capacity is a deterministic invariant. Peer eligibility continues through the existing resource, trust and lease checks. See the [Signal vs Authority standard](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

The patch adds no heuristic for choosing among competing signals. The existing peer selection and queue ordering handle that choice.

## 5. Interactions

A third peer can add one concurrent test and one status call per polling pass. Each machine can hold one reservation. The reservation, result import, retry and failover paths retain their existing lifecycle. The failed-file diagnosis coordinator can also consider the third peer. Its attempt limit and full-verification priority still apply.

## 6. External surfaces

The existing `GET /local-verify` response can include a third configured peer. An eligible third peer can produce a normal signed verification result for the existing merge gates. The configuration format, result shape and approval surfaces stay compatible.

## 6b. Operator-surface quality

No new operator control or UI is introduced.

## 7. Multi-machine posture

Machine-local by design. The holder reads its configured peer list and reports it through `GET /local-verify`. The status view refers to the active coordinator and its configured participants. The lease gate redirects a standby reader to the holder. This patch introduces no notice, URL, or durable state format.

## 8. Rollback cost

Remove the third entry after any reservation on it has drained, or revert and ship a patch. Draining first preserves the coordinator's ability to fetch and import its result. Existing installations with at most two valid entries require no configuration migration.

## Conclusion

The parser fixture covers the third peer, overflow, duplicates, self, and malformed URLs. The dispatch fixture checks distinct accepted reservations on three peers while the local slot is occupied. The migration fixture covers existing instructions and idempotence. The reviewer concurred with the change on static review and identified the failed-file diagnosis interaction recorded above.
