---
title: "Codex test-worker interruption and control-plane resilience"
author: "echo"
created: "2026-09-03"
status: "draft"
---

# Codex test-worker interruption and control-plane resilience

## Incident

Topic 67366 repeatedly displayed Codex's operator-interruption banner while the
operator had sent no interrupt. Durable watchdog evidence shows that
`SessionWatchdog` selected Vitest's long-lived `esbuild --service ... --ping`
child as a stuck user command and used pane-wide `Ctrl+C` as its first effect.
The control character reached Codex as well as the selected descendant. Later
SIGTERM escalation killed the esbuild service and collapsed the test runner.
Restarting the test created a new service PID and repeated the loop.

At the same time, the local Instar server listened on its configured port but
did not answer `/health` within five seconds. Process sampling showed the main
Node thread blocked in synchronous child execution while several internal Codex
classification subprocesses were live. Telegram lifeline forwarding timed out,
retried, and re-delivered the same operator message, breaking conversational
continuity and making background work appear silently stalled.

## Invariants

1. A watchdog-selected descendant may never cause a pane-wide control effect
   unless the pane's foreground process is itself the positively identified
   target and the effect is explicitly authorized for that process role.
2. Long-lived compiler, test-runner, language-server, and IPC service children
   are infrastructure, not evidence of a stuck user command merely because
   they are old or quiet.
3. Unknown process role fails toward observation, never interruption.
4. A targeted signal must re-bind PID, parent edge, and exact argv immediately
   before the effect. Session-level escalation must additionally resolve the
   current session record through `ReapAuthority`; PID-only authority is
   insufficient.
5. `/health` and inbound durability endpoints remain responsive while optional
   LLM classification is slow, saturated, or unavailable.
6. Optional classifiers use bounded asynchronous execution, shared concurrency
   and queue budgets, explicit timeouts, and fail-open/fail-closed behavior
   appropriate to the owning decision. They never synchronously block the HTTP
   event loop.
7. Telegram receipt is acknowledged only after durable queue custody. Retries
   preserve stable platform-message deduplication and cannot create two visible
   prompts for one message.
8. Background validation has a durable completion wake-up or observable
   continuation obligation; ending an assistant turn must not orphan a live
   test run without a later result delivery.

## Design boundaries

### Watchdog targeting

- Add a process-role classifier for known service-mode descendants based on
  executable identity and exact argv shape. Initial
  pinned contracts cover esbuild service mode under Vitest/Vite and must remain
  extensible without broad basename exemptions.
- Service descendants are excluded before the stuck-command judge. Their
  owning foreground test command remains eligible for higher-level progress
  assessment.
- Replace descendant remediation through tmux `send-keys C-c` with a targeted
  signal primitive guarded by an action-time identity recheck. Pane-wide
  `Ctrl+C` is allowed only when the positively selected target is the pane
  foreground process and no protected framework host shares the effect scope.
- Every refusal/intervention records target identity, role, scope, principal,
  reason, and whether the operator initiated it.

### Control-plane isolation

- Inventory request-path synchronous child execution and identify the exact
  source observed in the incident.
- Move optional classification off the event loop or behind the existing LLM
  queue. Enforce per-purpose and global concurrency, bounded queue depth,
  deadline cancellation, and coalescing/deduplication where inputs repeat.
- Keep `/health` independent of optional intelligence and expensive pool
  aggregation. A local health response must be bounded and side-effect free.
- Inbound forwarding and durable queue commit take priority over tone/profile/
  movement classification. Optional intelligence degradation is explicit and
  cannot block custody or response relay.

### Continuity

- Stable Telegram message IDs deduplicate re-forwarded input across lifeline
  retries and server recovery.
- A response ACK and final response remain independently observable.
- Long-running test commands are registered with a bounded continuation owner
  that wakes on completion/failure and emits concrete progress at the declared
  cadence without relying on the model remembering to poll.

## Testing requirements

- Unit: service-role classification on both sides of every argv/parent
  boundary; PID-reuse and unknown-role refusal; foreground versus descendant
  effect scope; queue/backpressure/timeout semantics.
- Integration: a real Vitest/esbuild process tree is never pane-interrupted;
  the owning test command remains observable; slow classifiers do not delay
  `/health` or durable inbound custody; repeated Telegram forward has one
  prompt and one delivery identity.
- E2E: production `server.ts` wiring with a live Codex-like foreground and
  Vitest/esbuild descendant reproduces the old failure and proves no
  conversation interruption, test collapse, duplicate prompt, or lost final
  wake-up.
- Migration and awareness: existing agents receive changed defaults/hooks and
  the generated agent template explains attributed watchdog intervention and
  control-plane degradation where user-visible.
- Full repository suite, independent side-effects review, clean-install smoke,
  deployment, and a live topic-67366 validation run are release gates.

## Rollback

Targeted signaling and service classification fail toward no destructive
watchdog effect. If control-plane isolation regresses, optional classifiers can
be disabled while durable inbound and health remain live. Rollback must not
restore pane-wide descendant interruption.
