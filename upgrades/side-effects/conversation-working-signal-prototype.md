# Side-effects review for the isolated Codex turn observer

**Scope:** Review-only checkpoint on the working-indicator branch.
**Author:** Echo.
**Independent reviewers:** Working checkpoint reviewer and integration reviewer.

## Summary of the change

This checkpoint preserves an isolated Codex turn observer, a bounded WebSocket frame reader, a local Unix relay, the disposable app-server controller, macOS peer verification source and four focused unit files. Production startup, SessionManager, routes, dashboards, and native package build have no references to these modules. The product design remains an unapproved draft.

## Decision-point inventory

- The order and identity of request, response and native turn determine whether a positive hint exists.
- The relay requires one positively identified peer on each local connected socket before copying.
- Startup and child disposal apply only to the disposable child owned by the caller. Directory cleanup uses the existing guarded filesystem executor.
- Expiry and malformed or missing evidence clear the hint without acting on the conversation.

## 1. Over-block

There is no production path. Within the isolated test, fragmented unobserved messages still pass through, but missing, unsupported or stale evidence can temporarily suppress the hint. The current conservative parser can clear on a mismatched completion within its selected thread. The managed-resume fixture can still pause at the ordinary hook-review prompt. This remains a product enabling blocker.

## 2. Under-block

There is no production path. The prototype does not establish that a real managed session preserves approvals, hook trust, resume, stop and restart ownership, or that the signed owner browser or another holder could safely receive anything. The prototype has no distributed proof and can hold an isolated caller's shutdown open while the OS reaps a child.

## 3. Level-of-abstraction fit

The turn is an in-memory presentation observation. Unix peer verification is a deterministic equality check on the accepted and connected descriptors, not an inferred authorization grant.

## 4. Signal vs authority compliance

Reference: [Signal vs. Authority](../../docs/signal-vs-authority.md).

The observer cannot authorize or deny any tool, message, retry, account placement, Stop or recovery. Kernel identity checks determine whether the disposable relay has the exact expected endpoints. The observed status has no action consumer.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Request and turn equality, the selected thread and a monotonic display deadline are precise conditions of this experimental contract. Payload limits are observation budgets, not filters on Codex content.

## 5. Interactions

- Shadowing and double-fire are absent from runtime because there is no caller, lifecycle listener, route or packaged native binary.
- Test-scope cleanup is idempotent and confined to the one temporary directory and session child. The relay closes both ends on transport loss.
- No feedback loop consumes the observed badge state.

## 6. External surfaces

No operator-facing actions, new route, persistent state or external service change. A normal TypeScript build may compile unused modules. This branch is for review only and must not merge or release.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

The disposable observation exists on the macOS kernel hosting both Unix sockets. Hardware-bound identity does not travel across machines. No user notices, status APIs, durable state or shared URLs.

## 8. Rollback cost

Remove or revert the prototype source and tests. There are no migrations, installed helpers, persistent fields or user settings. The authoring worktree's isolated probes are not installed.

## Independent review and evidence

Two separate reviewers checked the product import, runner and packaging boundaries and concurred for the isolated checkpoint after the packaging language was corrected. Focused unit verification passed all 22 tests after the guarded cleanup correction. The disposable real Codex probe observed matching peer PIDs, native start/completion, and the same blocked-then-allowed Stop result on fresh launches. Embedded resume passed. Managed resume paused at hook review and proceeded only after explicit approval inside the disposable fixture. This does not constitute product readiness.

## Class-Closure Declaration

No agent-authored-artifact defect. The unbounded-self-action class is not applicable. One explicit disposable launch owns one child. Its bounded startup checks do not spawn a replacement, and cleanup acts only on that exact owned child and relay. There is no automatic action loop or production caller.
