# Side-effects review — deterministic missing-acknowledgement proof

Date: 2026-11-17. Author: Echo. Tier 1: test harness only, reversible; no native or production TypeScript changes. Five code/test files plus ELI16 and release artifacts. One implementation pass with targeted regression iterations; parent and independent second review complete. No commit or gate attempts by the implementer.

## Problem and decision points

Case 12.18 started a polling STOP watcher after password submission began. The real guard could already have written its first heartbeat; the controller accepts that heartbeat for five seconds. The harness also lacked the actual guard-not-alive status mapping. This correction arms a stale immutable heartbeat before submission, records actual evidence, restores it, and judges only that constrained proof scenario.

## 1. Over-block

Any unfamiliar receipt, foreign-owned/linked file, symlinked store, existing marker/heartbeat, live competing driver, changed inode or unknown flags refuses setup/recovery. This may stop a proof run rather than guess ownership. It does not block production requests. A partial reserved receipt can be retired without touching the nonimmutable target file.

## 2. Under-block

The test proves missing fresh acknowledgement, not absence of a guard process. It requires a real guard PID, proof-user ownership, command/key and matching start second, the real viewer refusal, unchanged stale immutable heartbeat and explicit zero submissions. It does not prove every P12 safety property or fleet readiness. Files belonging to the same proof user are a trusted test environment, not a hostile-user security boundary.

## 3. Layer fit

Fault injection stays in scripts/locked-proof. The signed native helper and real controller execute unchanged. The driver collects observations, and the existing judge rejects incomplete evidence. No product test switch or alternate block authority is introduced.

## 4. Signal versus authority

Per docs/signal-vs-authority.md, this is a deterministic evaluator of an enumerated test condition. It changes a proof verdict and enforces file ownership before the harness modifies its own fixture, not an agent intent or message-flow policy.

## 5. Interactions and recovery

The receipt is durable before target creation; inode identity is durable before setting UF_IMMUTABLE. A reserved receipt cannot have set that flag. Release never deletes the heartbeat, and refuses unknown immutable replacements. Driver PID/start identity protects another live run; an unreadable process observation is not called dead. The complete password attempt is awaited. Before arming, an authenticated GET for the exact original viewer request must confirm approved status and a finite server expiry. The receipt records that expiry and durably marks the secret as possibly in flight before invoking the password UI. Normal release requires a confirmed exact-request revoke response, durably recorded. Observation or viewer-close failure cannot bypass that boundary. If revocation fails, the frozen heartbeat remains until a retry confirms revocation or the recorded server deadline passes. Startup and the rollback CLI enforce the same rule without retaining a viewer token; a new viewer cannot revoke the original request. Recovery retries on every exit and before startup/prepare waits. A stale fixture can briefly provoke normal guard replacement, so the normal path restores it immediately after refusal; it does not run the previous guard-STOP timer.

## 6. External surfaces

Only proof results and dedicated proof-account fixture files change. No production API, installed native helper, user notification, credential or permission changes. The fixture is a stale file, not a password. No operator surface is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: this is a filesystem fault on the dedicated proof Mac. It must not replicate. Source changes reach proof checkouts through source control. Receipts survive driver restarts on that Mac and contain the request key, ownership identity, file inode, server grant expiry and submission/revocation state; no session token. No URLs or notices are generated. No status/health/capabilities API changes.

## 8. Rollback

First run `sudo -n -u instarproof python3 scripts/locked-proof/guard-ack-fixture.py --execute release /Users/instarproof/.instar/desktop-helper/locked` after the owning proof driver has exited. Release is idempotent and leaves a producer's heartbeat intact. For a possibly submitted secret without confirmed revocation, it refuses until the recorded server expiry; wait for that boundary and retry, rather than clearing the flag manually. Then revert the commit. No production migration or restart is needed. A cleanup refusal is a failed proof with retained evidence, never permission to clear unknown files manually.

## Validation and review

Targeted tests cover actual immutable-file rejection/restoration in disposable directories, crash windows before creation and inode recording, unknown files, ownership changes, symlink/path confinement, overlapping drivers, setup ordering, awaited secret lifecycle, cleanup failures including failed revoke plus failed viewer close, durable submission/revocation boundaries, startup retention until expiry and missing/false evidence. The dashboard parser test reads the real message from dashboard/desktop.js. Full-suite authority belongs to Local Verify before merge. Parent review and independent second review concur after fixing the in-flight cleanup blocker. Parent independently reran 98/98 targeted tests; 802/802 fast guard tests across 30 files passed. No live-Mac proof is claimed.

## Class-closure declaration

No prompt, hook, config, skill or standards-text defect; no self-triggered production controller. Not applicable. The harness regressions guard this concrete false-proof class.

Final review: parent and independent reviewer lock_call_measurement_design inspected schema2 durable submission/revoke/expiry boundaries and real DirectDesktopAccess deadline behavior; no remaining blocker. Earlier review correctly rejected unconditional cleanup. Full verification remains Local Verify before merge.
