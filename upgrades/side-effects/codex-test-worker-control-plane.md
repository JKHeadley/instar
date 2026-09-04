# Side-Effects Review — Codex test-worker interruption and control-plane resilience

**Version / slug:** `codex-test-worker-control-plane`  
**Date:** `2026-09-04`  
**Author:** `Codex`  
**Second-pass reviewer:** `Codex independent reviewer`

## Summary of the change

This change protects exact esbuild service descendants before watchdog judgment, replaces pane-wide interruption with identity-fenced process signals, removes synchronous tmux probes from selected asynchronous server hot paths, and preserves honest durable lifeline replay reasons. It updates watchdog, session/input monitoring, lifeline, migration, scaffold awareness, and their unit/integration/E2E coverage.

## Decision-point inventory

- `SessionWatchdog.checkSession` — modify — exact service-role evidence prevents a destructive action against infrastructure.
- `SessionWatchdog.signalIfIdentityMatches` — add — a deterministic safety fence revalidates the selected process before signaling.
- `SessionManager.listRunningSessions` — modify — asynchronous hot paths trust the state registry/cache rather than blocking on tmux.
- `StuckInputSentinel.tick` — modify — idle Codex sessions without durable stranded-draft evidence avoid synchronous pane probing.
- `TelegramLifeline` replay notice — modify — chooses wording from the durable queue cause.

## 1. Over-block

An esbuild process with the exact `--service... --ping` contract is always protected even if that helper itself malfunctions. This is intentional: the owning test command remains observable, and killing its internal compiler helper is not a safe recovery action. One-shot esbuild invocations and shell commands merely mentioning those flags are not exempt.

## 2. Under-block

Other long-lived compiler or language-server protocols are not automatically protected unless already covered by framework ownership/exclusions. The fix is deliberately exact to the observed process contract. A process that preserves PID, parent, and exact argv across an exec-like behavioral change could pass the identity fence; session-level termination still goes through ReapAuthority.

## 3. Level-of-abstraction fit

Service classification is a low-level structural safety floor at the point that selects process targets. The contextual stuck-command authority still judges eligible user commands. Targeted signaling is the lower-level primitive the watchdog should use; final lifecycle authority remains centralized in ReapAuthority. Queue-cause formatting is a pure presentation helper over already-durable facts.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the service classifier is a safety guard on an irreversible/disruptive action, an explicit exception allowed by the principle.

The exact argv classifier cannot authorize interruption; it can only refuse an unsafe target. Positive stuck judgments remain with the existing contextual authority or hard-ceiling policy, and final session death remains with ReapAuthority.

## 4b. Judgment-point check (Judgment Within Floors standard)

The new heuristic is not a competing-signals judgment point. It is an enumerable process-protocol identity used solely as a no-kill safety floor; it never chooses to act. The existing contextual judge continues to resolve competing evidence for non-infrastructure commands.

## 5. Interactions

- **Shadowing:** service protection runs before exclusions and the stuck judge; this intentionally prevents the judge from acquiring authority over the helper.
- **Double-fire:** targeted SIGINT replaces, rather than supplements, pane-wide Control-C. StuckInputSentinel remains independent and only submits a durable marked draft.
- **Races:** every descendant signal rechecks PID, parent, and exact argv; failed identity checks delete escalation state. Escalation also binds session id and start timestamp, then refuses a replacement incarnation even if it reuses the tmux name. ReapAuthority re-resolves that same live session.
- **Feedback loops:** a protected esbuild helper is reevaluated each poll but produces no intervention. Queue replay keeps stable delivery identity and cause.

## 6. External surfaces

Codex users stop seeing false operator-interruption banners and test runs stop collapsing from killed esbuild services. Telegram users may see corrected wording that distinguishes a server outage from a forwarding failure. Queue records gain an optional cause field compatible with older records. Timing remains machine-load dependent, but the affected event-loop paths no longer execute synchronous tmux probes. No operator-facing action is added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard, approval, grant, revoke, or secret-entry surface is changed; not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** process trees, tmux sessions, watchdog targets, and local server availability are machine-specific truths. Telegram queue notices use the existing one-voice lifeline path and stable message identity; no new notice producer is introduced. Durable queue state remains in the existing agent state path and this change does not alter topic-transfer ownership. No URLs are generated.

## 8. Rollback cost

Pure code and backward-compatible record metadata: revert and ship a patch. No schema migration or state repair is required; old queue entries without a cause retain compatible fallback wording. Rolling back would re-expose false interruption and event-loop stalls during propagation.

## Conclusion

The first independent pass found missing session-incarnation fencing, incomplete effect-scope audit fields, and mocked-only process evidence. The implementation now binds escalation to session id/start time, records parent/role/scope/incarnation, and includes an integration test that launches the installed esbuild binary and inspects the real host process table. The repair is at the correct layers and narrows destructive authority; it is clear to ship after the confirming second pass.

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer  
**Independent read of the artifact:** concur — the revised implementation closes the session-replacement race, records target/effect attribution, and proves against a live esbuild process tree that service descendants stay outside interruption authority.

## Evidence pointers

- `tests/unit/session-watchdog-attribution.test.ts`
- `tests/integration/session-watchdog-safe-wait.test.ts`
- `tests/integration/tmux-resilience-slow-stub.test.ts`
- `tests/e2e/session-watchdog-continuation-lifecycle.test.ts`
- `tests/e2e/lifeline-queue-notice-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType: ratchet, citation: tests/unit/SessionWatchdog-pipeline.test.ts, howCaught: the tests require exact service descendants to remain outside judgment and require every descendant intervention to use the identity-fenced targeted signal path, preventing repeated pane-wide interruption while bounded escalation and ReapAuthority remain the settling brakes }`.
