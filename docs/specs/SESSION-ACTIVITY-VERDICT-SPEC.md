---
title: Unified Session-Activity Verdict — one truth about whether a session is working
status: draft
review-convergence: pending
approved: false
owner: echo
builder: tbd (echo or codey per slice; echo owns convergence)
date: 2026-06-05
eli16-overview: SESSION-ACTIVITY-VERDICT-SPEC.eli16.md
fixtures:
  - "2026-06-05 14:30Z server.log: SessionManager age-limit defer logs 'actively working (procs=true, idleAtPrompt=true)' for a session 1127m past its 240m limit — self-contradictory INSIDE one log line; the promised 'idle-detection block will catch it' had not caught it for ~15h"
  - "task #78 originating UX: an ack'd user message later reported undelivered while 'actively working' receipts streamed, and the watchdog simultaneously declared the same session stuck — three reporters, three verdicts, one session"
  - "PR #722 (merged): the REAPER's keep heuristic had the same procs-exists≠activity fallacy and was fixed with descendant-CPU progress — but only for the reaper; SessionManager's age-limit defer, restart-deferral (#20/#47), and the receipts path still improvise their own answers"
---

# Unified Session-Activity Verdict

## Problem

At least five independent components answer the same question — "is this session actually doing work right now?" — each with its own heuristic, and they disagree in user-visible ways:

1. **SessionManager age-limit defer** — `procs=true` (a child process EXISTS) ⇒ "actively working", even with `idleAtPrompt=true` (fixture 1: both printed in one line).
2. **SessionReaper keep/kill** — fixed by #722 to require positive descendant-CPU progress under pressure; the correct heuristic, but private to the reaper.
3. **Restart-deferral / UpdateGate blocker count** (#20/#47) — counted day-old idle topic sessions as "active", blocking urgent deploys.
4. **ActiveWorkSilenceSentinel / watchdog** — transcript growth + spinner-stripped pane hashing (#63), declaring "stuck/faking work".
5. **User-facing receipts & presence** ("actively working on it…") — optimistic, fed by yet another path.

The result is the task-#78 UX: the user is told a message was received and worked on, then told it was undelivered, while the watchdog calls the session stuck — three contradictory stories about one session in one hour. Internally, every new consumer re-derives activity ad hoc, and every fix (like #722) lands in exactly one consumer.

## Fix shape: one verdict, computed once, consumed everywhere

A single `SessionActivityVerdict` produced by one funnel (`SessionActivityService`), built from the inputs the components already gather — no new probes:

```
verdict: {
  state: 'working' | 'idle-at-prompt' | 'stalled' | 'dead' | 'unknown',
  confidence: 'observed' | 'inferred',
  inputs: {
    descendantCpuSeconds: number | null,   // #722's progress delta
    idleAtPrompt: boolean | null,          // pane-shape detection
    transcriptGrowthBytes: number | null,  // since last sample
    paneHashChanged: boolean | null,       // spinner-stripped (#63)
    lastInjectionAgeMs: number | null,
  },
  asOf: timestamp, ttlMs: number
}
```

### Decision table (the semantic core — both sides of every boundary tested)

| descendant CPU progress | idleAtPrompt | transcript/pane progress | verdict |
|---|---|---|---|
| positive | false | any | working |
| positive | true | none | idle-at-prompt (children busy ≠ session busy: MCP keep-alives) |
| zero | false | growth | working (LLM turn, low CPU) |
| zero | false | none, sustained | stalled |
| zero | true | none | idle-at-prompt |
| process gone | — | — | dead |
| inputs unreadable | — | — | unknown (NEVER guessed; consumers fail to their existing conservative behavior) |

### Consumers (migrated one per slice, each with its own both-sides tests)

1. SessionManager age-limit defer — defer only on `working`; `idle-at-prompt` falls through to the idle-kill path it always promised would catch it.
2. Restart-deferral / UpdateGate — `idle-at-prompt` sessions are NOT restart blockers (closes the #20/#47 class).
3. Receipts/presence — "actively working" is only uttered on a `working` verdict; `stalled` switches the user-facing language honestly.
4. Watchdog/silence sentinels — consume the same verdict for consistency; their nudge/escalation policy is unchanged.
5. Reaper — already #722-correct; refactored to read the shared funnel (behavior-preserving slice).

### Non-goals

- No new monitoring processes or sampling cadences (reuse ResourceLedger/#706 descendant-CPU, existing pane captures).
- No change to any KILL policy in this spec — consumers keep their own authority; this unifies the FACTS they act on (signal vs authority).
- No cross-machine verdict (per-machine, like the inputs).

## Components & tests (Tier-2, three tiers)

1. `src/core/SessionActivityService.ts` — pure decision table + input assembly; unit tests for every row incl. unknown-input degradation.
2. Consumer slices (5, listed above) — each an integration test proving the consumer's behavior flips correctly on both sides of the verdict boundary.
3. E2E feature-alive: production init path constructs the service and at least one consumer reads a real verdict.
4. Ships behind `monitoring.sessionActivityVerdict` (developmentAgent pattern: live on echo+codey, dark fleet), consumer migrations individually flagged.

## Open questions for convergence

1. TTL/staleness: verdicts cached per tick or computed on demand per consumer call? (Lean: computed on demand with a 5s memo — consumers tick at different cadences.)
2. Should `stalled` require N consecutive no-progress samples (debounce) and is N shared or per-consumer? (Lean: shared debounce in the service — that's the point.)
3. Codex/gemini parity: descendant-CPU works for all frameworks, but idleAtPrompt pane-shape detection is framework-specific — is `null` acceptable for non-claude frameworks in v1, with the decision table's null-tolerant rows? (Lean: yes; #706 already proved CPU-only detection for codex jobs.)
