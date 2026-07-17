---
title: Codex task-ledger self-continuation
status: approved
author: instar-codey
date: 2026-07-16
parent-principle: "The Agent Carries the Loop"
review-convergence: "2026-07-16 — codex/gpt-5.5 round found six minor issues; all folded in b2af931bc (mutation boundary, exact parser grammar, atomic generation+tombstone recheck, restart adoption excluded, alternatives, liveness-only framing). Operator review then approved with no required fixes."
review-iterations: 2
approved: true
approval-note: "Justin, topic 458, 2026-07-16 18:17 PDT: APPROVED, no required fixes; arm #1489 and proceed to implementation."
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

Only task boxes parsed by the repository's bounded task-line parser are task authority. An eligible task is a physical line outside fenced code blocks, HTML comments, and blockquotes, matching `^[ ]{0,3}- \[([ xX])\] \S`; nesting, escaped brackets, ordered-list boxes, and boxes beyond the body byte cap are ineligible. Input is normalized from CRLF to LF before parsing. `- [ ]` is open; `- [x]` and `- [X]` are closed. Ordinals are the stable eligible-line order in the current generation. An empty body, zero eligible boxes, malformed front matter, or zero open boxes is terminal/allow. Unlike autonomous completion discipline, “no task structure” does not conservatively invent one open item. Unit fixtures pin every exclusion so a later parser refactor cannot broaden authority accidentally.

The writer uses atomic temp-file + rename and clamps fields and body size. Every generation includes a server-minted random `generation` and a content digest over the normalized task body. All supported mutation goes through `CodexTaskContinuationStore` via the authenticated API/CLI; direct file edits are unsupported drift. On a digest mismatch the decision path records `invalid-state`, deactivates, and allows the stop rather than adopting hand-edited authority. The ledger is local runtime state and is excluded from git and cross-machine sync.

### 4.2 Lifecycle API and CLI

Add a server-owned lifecycle surface and an `instar continuation` CLI wrapper:

- `start --topic <id> --duration <bounded> --max-continuations <bounded>` creates/replaces the topic ledger from task-box input;
- `status --topic <id>` returns sanitized counts and bounds, never raw task prose in aggregate telemetry;
- `complete --topic <id> --task <ordinal>` checks one existing box atomically;
- `stop --topic <id>` writes the operator-stop tombstone, then deactivates the ledger;
- `stop-all` writes the global operator-stop tombstone before deactivating all ledgers.

This is an explicit work declaration, not a classifier. The agent may create/update it as the durable plan for a multi-step assignment; the mechanism never derives tasks on its behalf. The API is the mutation boundary even when the caller is the agent—the operator is never asked to run the CLI or edit the file.

## 5. Turn-boundary decision order

Extend the existing `autonomous-stop-hook.sh --codex` path after its global Codex feature gate and before it returns for “no autonomous job.” Autonomous state retains precedence and is behaviorally unchanged. When there is no owned autonomous state, evaluate an owned continuation ledger in this exact order:

1. **Hard off-switch:** if `autonomousSessions.codexTaskContinuation.enabled !== true`, approve.
2. **Operator stop:** if the global or topic tombstone is newer than the ledger, deactivate and approve. This check precedes all recovery, task, or completion logic.
3. **Ownership:** resolve the topic through the existing topic/session registry. Require the ledger topic and recorded session id to match the hook. Unknown ownership or a restart/session-id mismatch approves. Restart adoption is a deliberate v1 non-goal; the agent can explicitly start a new generation after resume.
4. **Bounds:** invalid/missing start time, duration outside the configured maximum, elapsed duration, invalid continuation count, or count at ceiling deactivates and approves. Parsing fails toward stop, not continue.
5. **Task truth:** parse the bounded body. Zero task boxes or zero unchecked boxes deactivates and approves.
6. **Continue:** under a cross-process atomic lock, re-read and revalidate the tombstone timestamps, generation, digest, ownership, bounds, and current task count; then increment `continuation_count`, persist by atomic rename, append an audit row, and release the lock. A changed generation or tombstone during lock acquisition returns allow. Only after that transition commits does the endpoint emit one Codex Stop block object. The reason names the remaining task count and instructs Codex to reread the ledger and continue the first open item. It does not quote task prose into the control instruction.

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
- **Session restart:** v1 fails open on session-id mismatch and never adopts automatically. A resumed agent may explicitly start a new bounded generation from its still-visible plan.
- **Empty list:** stop immediately. The hook never asks a completion judge to manufacture another task.

## 9. Implementation shape

1. Add a typed `CodexTaskContinuationStore` for atomic ledger/tombstone/audit operations, digest validation, bounded parsing, and a bounded cross-process lock. Lock timeout or stale-lock ambiguity fails open and is audited when possible.
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
- Any session-id mismatch approves; restart adoption is not present in v1.

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

## 13. Alternatives considered

- **Codex plan-tool state:** not exposed as a stable, server-readable contract across CLI versions and cannot currently be used by the Stop hook without guessing at UI state.
- **Existing autonomous-job state:** already has the right hook primitive but carries autonomous registration, completion-judge, concurrency-cap, and notification semantics that ordinary interactive work should not silently acquire.
- **SQLite as the sole task store:** gives stronger transactions, but makes the explicit plan opaque to the working agent and operator and duplicates the readable task artifact that already survives compaction. V1 keeps Markdown as the readable source with a server-minted generation/digest and a cross-process critical section. If live testing shows lock or rewrite churn, SQLite plus a generated Markdown view is the named fallback—not an in-place improvisation.
- **A watcher that injects messages after idle:** races prompt detection and inbound operator turns, and duplicates a native Stop-boundary primitive that is already installed and trusted.

This feature is a liveness controller only. Checked boxes and successful audit rows are not evidence that the engineering work is correct; correctness remains governed by tests, review, and the normal delivery bar.
