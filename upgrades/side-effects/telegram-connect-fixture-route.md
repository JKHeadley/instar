# Side-Effects Review — Telegram connection fixture route

**Version / slug:** `telegram-connect-fixture-route`
**Date:** `2026-11-23`
**Author:** `echo`
**Second-pass reviewer:** `connect_main_review`, independent review; no tests launched by reviewer.

## Summary of the change

Tier 1, test-only repair at main ec9401e5. The dual-address TCP fixture now blocks its final IPv6 address with Node's real BlockList instead of assuming the computer immediately rejects it. The old and production connection-window outcomes are separate tests. The error assertions distinguish the first timeout from the blocked fallback. No runtime code, timeout, retry policy, package, installed file or migration changes.

## Decision-point inventory

No production decision-point surface. The test fixture modifies how its deliberately unavailable fallback fails. The production dispatcher window, transport proof classifier and process networking defaults pass through unchanged.

## 1. Over-block

No production block/allow surface — over-block not applicable. The BlockList belongs only to the fixture socket and contains only its synthetic IPv6 address.

## 2. Under-block

No production block/allow surface — under-block not applicable. The test still checks an actual TCP connection under a real event-loop pause. It does not prove behavior during a stall longer than the production connection window or actual Telegram provider availability.

## 3. Level-of-abstraction fit

The defect is an environmental assumption in the test fixture. Node's existing socket-local BlockList gives deterministic fallback rejection without introducing a fake socket or changing production transport behavior. There is no new timer or timeout widening.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface in production.

Reference: [signal vs authority](../../docs/signal-vs-authority.md). Tests observe existing transport behavior; they do not grant retry authority. The synthetic ERR_IP_BLOCKED aggregate remains unclassified by provedUnsentCode.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. This is a closed test fixture, with explicit expected errors.

## 5. Interactions

No shadowing, double-fire, persistent-state race or feedback loop is introduced. The real first connection and event-loop pause remain. The second address never reaches a host route. Successful sockets are destroyed and the fixture server closes during teardown. Safe-retry proof is asserted on the actual timeout child; the aggregate including the synthetic blocked error stays unknown. Independent review required that distinction, and it was applied without changing the runtime allowlist.

## 6. External surfaces

No external surface changes. No operator-facing actions. The fixture uses its own ephemeral loopback TCP server; its fake DNS results are supplied locally. There are no Telegram calls, production restarts, installations or live resends. Main's test queue benefits from removal of a host-route dependency.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: each test process creates its own loopback fixture. Its unavailable fallback is refused within Node independently of that computer's routing table. No durable state, user-facing notice, URL, status, health or capability answer is added or changed.

## 8. Rollback cost

A normal revert restores the previous test. No data migration or agent state repair. Reverting could restore the hanging fixture; it changes no user runtime behavior.

## Test coverage and verification

The original main file timed out at its unchanged thirty-second cap twice. A diagnostic run recorded the IPv4 attempt timing out and the final IPv6 attempt starting without completing. Node 24's loaded net implementation sets its attempt timer only on nonfinal addresses. The new fixture checks ETIMEDOUT followed by ERR_IP_BLOCKED, retains the proven-unsent timeout-child assertion, and requires the production connection window to connect successfully through the same pause. The shared dispatcher test continues checking an actual dispatcher and unchanged process default.

Final focused run: 28/28 passed across the connection fixture (3, 807 ms) and adjacent transport-deadlines suite (25, 33.355 s), under enforcing targeted admission. The earlier unfixed diagnostic run also used enforcing admission; the first reproduction inherited the default dry-run posture and is not claimed as enforcing. Full-suite custody is recorded in the handoff and build summary. The full suite goes through throughput; no full-suite pass, deployment or live provider acceptance is claimed. Additional integration and lifecycle tests are unnecessary for a change confined to a unit fixture with no runtime feature or wiring change.

## Self-action declaration

`unbounded-self-action`, closure n/a: no new controller, trigger, timer, retry, cadence, budget or runtime permission. This change is confined to a test fixture.

## Review and proportion

SMALL, one independent review round. The reviewer concurred conditionally on correcting the transport-proof assertion; that correction is present in the final file. Normal lint and commit gates remain required. Full exact-head verification stays with throughput.
