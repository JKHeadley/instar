---
title: Codex task-ledger self-continuation
status: draft
author: instar-codey
date: 2026-07-16
approved: false
---

# Codex task-ledger self-continuation

> Keep an ordinary interactive Codex session working across turn boundaries while, and only while, its explicit durable task list still contains open work.

## 1. Problem and evidence

During the 2026-07-16 Instar development drive, one Codex session ended five turns with an assigned item still open. Each turn left the work parked until the operator or mentor sent another message. The code and plan artifacts survived; the missing mechanism was re-engagement at the turn boundary.

Instar already ships the right execution primitive: the project-scoped Codex `Stop` group ends with `autonomous-stop-hook.sh --codex`. That hook is trusted with the other Instar hooks, emits Codex-safe block JSON, anchors state to the agent home, and already gives emergency stop and duration expiry terminal precedence. Its current state selector, however, only recognizes `.instar/autonomous/<topic>.local.md`; ordinary operator-assigned interactive work has no state it can honestly continue from.

## 2. Goal

Add a small, explicit task-ledger mode to the existing Codex loop driver. At a Codex turn boundary it blocks the stop and returns a continuation prompt only when the current topic/session owns a live ledger with at least one unchecked task.

The loop must be:

- bounded: duration and continuation-count ceilings;
- stoppable: a hard config off-switch and operator-stop tombstone win before every continue decision;
- honest: no ledger or zero open tasks means approve the stop, with no synthesized work;
- observable: every allow/continue/suppression decision is appended to a bounded audit log.

## 3. Non-goals

- No LLM inference of tasks from conversation prose.
- No automatic creation of filler tasks, no conversion of notes into tasks, and no continuation based only on a dirty worktree or vague “active work” signal.
- No second watcher, timer, or message-injection loop competing with the native Codex Stop hook.
- No change to Claude behavior or autonomous-job completion discipline.
- No promise that the ledger proves semantic completion. It proves only that the agent explicitly recorded open work.

## 4. Durable state

### 4.1 Per-topic ledger

Store local-only ledgers at `.instar/continuation/<topicId>.local.md`:

```yaml
---
version: 1
active: true
topic_id: "458"
session_id: "<codex session id>"
started_at: "2026-07-17T01:00:00Z"
duration_seconds: 14400
continuation_count: 0
max_continuations: 40
updated_at: "2026-07-17T01:00:00Z"
---

- [ ] J — self-continuation loop
- [ ] K — hour-form liveness
- [ ] L — scripted Playwright lease
```

Only CommonMark task boxes in the body are task authority. `- [ ]` is open; `- [x]` and `- [X]` are closed. An empty body, zero boxes, malformed front matter, or zero open boxes is terminal/allow. Unlike autonomous completion discipline, “no task structure” does not conservatively invent one open item.

The writer uses atomic temp-file + rename and clamps fields and body size. The ledger is local runtime state and is excluded from git and cross-machine sync.

### 4.2 Lifecycle API and CLI

Add a server-owned lifecycle surface and an `instar continuation` CLI wrapper:

- `start --topic <id> --duration <bounded> --max-continuations <bounded>` creates/replaces the topic ledger from task-box input;
- `status --topic <id>` returns sanitized counts and bounds, never raw task prose in aggregate telemetry;
- `complete --topic <id> --task <ordinal>` checks one existing box atomically;
- `stop --topic <id>` writes the operator-stop tombstone, then deactivates the ledger;
- `stop-all` writes the global operator-stop tombstone before deactivating all ledgers.

This is an explicit work declaration, not a classifier. The agent may create/update it as the durable plan for a multi-step assignment; the mechanism never derives tasks on its behalf.

## 5. Turn-boundary decision order

Extend the existing `autonomous-stop-hook.sh --codex` path after its global Codex feature gate and before it returns for “no autonomous job.” Autonomous state retains precedence and is behaviorally unchanged. When there is no owned autonomous state, evaluate an owned continuation ledger in this exact order:

1. **Hard off-switch:** if `autonomousSessions.codexTaskContinuation.enabled !== true`, approve.
2. **Operator stop:** if the global or topic tombstone is newer than the ledger, deactivate and approve. This check precedes all recovery, task, or completion logic.
3. **Ownership:** resolve the topic through the existing topic/session registry. Require the ledger topic to match. Require the recorded session id to match the hook session id, except for one server-authored restart adoption carrying the existing topic/session resume evidence. Unknown ownership approves.
4. **Bounds:** invalid/missing start time, duration outside the configured maximum, elapsed duration, invalid continuation count, or count at ceiling deactivates and approves. Parsing fails toward stop, not continue.
5. **Task truth:** parse the bounded body. Zero task boxes or zero unchecked boxes deactivates and approves.
6. **Continue:** atomically increment `continuation_count`, append an audit row, and emit one Codex Stop block object. The reason names the remaining task count and instructs Codex to reread the ledger and continue the first open item. It does not quote task prose into the control instruction.

Operator stop has temporal precedence: after a stop tombstone, no stale hook process may reactivate or rewrite the ledger. Start requires a new ledger generation newer than the tombstone.

## 6. Bounds and defaults

Configuration lives at `autonomousSessions.codexTaskContinuation`:

```json
{
  "enabled": false,
  "maxDurationSeconds": 14400,
  "maxContinuations": 40,
  "auditRetentionDays": 14,
  "auditMaxRows": 5000
}
```

- Ships dark fleet-wide. The development agent can opt in explicitly for live testing.
- `enabled:false` is the instant hard off-switch and is read on every Stop invocation.
- A ledger may request smaller bounds, never larger ones.
- Duration is mandatory. Missing or unparseable duration/start time approves the stop.
- The continuation counter is a second independent ceiling so a rapid Stop-hook loop cannot burn the full wall-clock budget.

## 7. Auditability

Append decisions to `.instar/continuation/audit.local.jsonl` with:

```ts
type ContinuationDecision = {
  ts: string;
  topicId: string | null;
  sessionIdHash: string | null;
  ledgerGeneration: string | null;
  decision: 'continue' | 'allow' | 'deactivate';
  reason: 'disabled' | 'operator-stop' | 'no-ledger' | 'ownership-mismatch' |
    'invalid-state' | 'duration-expired' | 'continuation-ceiling' |
    'no-task-structure' | 'all-tasks-complete' | 'open-tasks';
  openTaskCount: number | null;
  continuationCount: number | null;
};
```

No task text, conversation text, or raw session id is logged. Rotation enforces both age and row caps. Audit-write failure is fail-open: approve the stop, because an unobservable self-continuation is outside this feature's contract.

## 8. Interaction rules

- **Autonomous job present:** the existing autonomous path owns the stop. The task ledger is ignored and its counter does not advance.
- **Other Stop hooks block:** Codex combines the existing group decisions. This feature adds no separate group or trust slot.
- **Inbound operator message:** ordinary delivery remains possible. A stop/emergency-stop message first writes the tombstone through the existing stop funnel; later delivery cannot be fought by a stale continuation.
- **Session restart:** default is fail-open on session-id mismatch. The existing server-controlled resume path may atomically adopt the ledger to the new session id once, preserving topic and generation and auditing `restart-adopted` as metadata.
- **Empty list:** stop immediately. The hook never asks a completion judge to manufacture another task.

## 9. Implementation shape

1. Add a typed `CodexTaskContinuationStore` for atomic ledger/tombstone/audit operations and bounded parsing.
2. Add authenticated local lifecycle routes plus the CLI wrapper. Mutating stop routes reuse the existing emergency-stop/operator-origin plumbing.
3. Add a small framework-neutral decision helper whose result is serialized by the shell hook. Keep shell responsible only for hook input/output and invoking the local decision endpoint; keep state transitions in TypeScript.
4. Extend the existing Codex Stop hook’s no-autonomous-job branch to call that endpoint. Empty response means allow; one validated `{decision:"block",reason}` object means continue.
5. Add config types/default migration and capability/status reporting. Migration installs the updated hook through the existing always-overwrite managed-hook path; no existing ledger is created automatically.

## 10. Acceptance criteria

### Tier 1 — unit

- Ledger parser distinguishes open, complete, empty, malformed, oversize, and zero-box bodies.
- Decision table pins every ordered reason in §5.
- Operator tombstone always wins, including a simulated stale concurrent continue.
- Duration and count ceilings independently stop the loop.
- Audit append failure returns allow; rotation enforces both caps.
- Task text and raw session ids never appear in audit rows.

### Tier 2 — integration

- Start a ledger through the authenticated route, invoke the real decision endpoint for the owned Codex session, and receive continue; complete the final task and receive allow.
- Invoke topic stop and stop-all between two decisions and prove the second decision cannot continue.
- Toggle the config off between two decisions and prove the next Stop approves without restart.
- An autonomous state plus a task ledger exercises only the autonomous path.
- Restart adoption succeeds only through the server-authored resume seam; arbitrary session mismatch approves.

### Tier 3 — feature alive

- In a disposable real Codex TUI, start a two-item ledger, let the first turn end, observe a native Stop block and a second model turn without operator input, close both boxes, and observe a clean idle prompt.
- Repeat with operator stop during the first continuation and prove no further model turn begins.
- Repeat at the continuation ceiling and duration ceiling.
- Verify the audit contains the decisions and no task prose.

## 11. Rollout and rollback

1. Land behind the dark default.
2. Enable only on the development agent for a bounded live test covering normal continuation, honest completion, operator stop, and both ceilings.
3. Observe audit rows and hook health through at least ten assigned multi-turn items before considering broader rollout.

Rollback is one config flip. Because the hook reads it on every turn and approves when false, rollback requires no restart and cannot strand a session. Ledger files may remain inert until retention cleanup; they never reactivate without a newer explicit start.

## 12. Frontloaded decisions

- Reuse the existing trusted Codex Stop group; no competing watcher.
- Explicit task boxes are the only work authority; no semantic task inference.
- Empty/invalid state fails toward stop.
- Operator stop and the off-switch precede every continuation.
- Both wall-clock and iteration bounds are mandatory.
- Audit failure fails open.
- Separate spec and implementation PRs: this touches hook lifecycle, state concurrency, and operator-stop precedence, so review the contract before source changes.

