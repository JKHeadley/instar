---
title: Unified Session-Activity Verdict — one truth about whether a session is working
status: converged
review-convergence: "codey adversarial review applied (PR #845 comment, 2026-06-05T16:38Z) — architecture approved; staleness/sampling ownership, per-consumer unknown matrix, and reaper guard preservation tightened below per review"
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
| zero | **null** | none, sustained | stalled (progress signals alone may prove stalled/working) |
| zero | **null** | none, not sustained | **unknown — null prompt-shape NEVER produces positive idle-at-prompt** |
| process gone | — | — | dead |
| inputs unreadable | — | — | unknown (NEVER guessed; consumers fail per the unknown matrix below) |

**Null-input rule (review-hardened):** CPU/transcript/pane progress can prove `working` or `stalled` for any framework; only a characterized prompt-shape detector can prove `idle-at-prompt`. A framework with `idleAtPrompt: null` (codex, gemini in v1) can never yield positive idle — destructive consumers see `unknown` and keep, exactly the posture the reaper uses for those frameworks today.

### Sampling & staleness contract (converged per review)

- **On-demand with a 5s memo, keyed per session.** One sampled **input bundle** per session window with one `asOf`; every consumer call inside the window reads the SAME bundle. This is also the CPU-delta single-writer rule: descendant-CPU is a delta signal, and independent sampling would let the first caller consume the delta and leave later callers flat/unknown. Tests must prove two consumers in one window get the same verdict.
- **Expiry is conservative.** Destructive or user-facing consumers MUST be able to reject an expired memo as `unknown` (or force-refresh) rather than reuse a stale `working`/`idle` across a boundary. A verdict captured before a new user injection or transcript change is invalid for decisions after that boundary — tests required for expired memo, force-refresh, and sample-changed-after-memo.
- **Debounce lives in the service as a FACT, thresholds stay with consumers.** The service reports "sustained no-progress for N samples / duration"; the watchdog, compaction recovery, presence, and restart gate each decide what that means operationally. A single shared action threshold would recreate the overreach this spec removes.

### Consumers (migrated one per slice, each with its own both-sides tests)

1. SessionManager age-limit defer — defer only on `working`; `idle-at-prompt` falls through to the idle-kill path it always promised would catch it.
2. Restart-deferral / UpdateGate — `idle-at-prompt` sessions are NOT restart blockers (closes the #20/#47 class).
3. Receipts/presence — "actively working" is only uttered on a `working` verdict; `stalled` switches the user-facing language honestly. **Completion-without-relay guard:** `idle-at-prompt`/`dead` after a user message is not "finished" from the user's perspective — receipts require reply-marker/final-output accounting before suppressing updates as done (the Gemini final-output-relay miss, task #83, is the fixture).
4. Watchdog/silence sentinels — consume the same verdict for consistency; their nudge/escalation policy is unchanged.
5. Reaper — already #722-correct; refactored to read the shared funnel. **Behavior-preserving by construction:** the shared verdict may replace only the activity sub-decision; the reaper's authority guards (protected / recovery-in-flight / pending-injection / recent-user / open-commitment / structural-long-work, plus conservative positive-idle handling) are untouched and keep veto power. `active-process`/busy-child nuance never becomes a kill signal via this migration.

### Unknown-fallback matrix (per consumer — "conservative" means different things)

| Consumer | On `unknown` |
|---|---|
| SessionManager age-limit defer | defer (treat as possibly-working — never kill on unknown) |
| Restart-deferral / UpdateGate | count as blocker (defer restart), bounded by existing maxDeferral |
| Receipts/presence | never say "actively working"; neutral "checking on it" language |
| Watchdog/silence sentinels | continue current bounded escalation path unchanged |
| Reaper | keep (existing posture) |

Without this table, `unknown` becomes the next private heuristic — each consumer's unknown behavior is a tested contract, not an improvisation.

### Non-goals

- No new monitoring processes or sampling cadences (reuse ResourceLedger/#706 descendant-CPU, existing pane captures).
- No change to any KILL policy in this spec — consumers keep their own authority; this unifies the FACTS they act on (signal vs authority).
- No cross-machine verdict (per-machine, like the inputs).

## Components & tests (Tier-2, three tiers)

1. `src/core/SessionActivityService.ts` — pure decision table + input assembly; unit tests for every row incl. unknown-input degradation.
2. Consumer slices (5, listed above) — each an integration test proving the consumer's behavior flips correctly on both sides of the verdict boundary.
3. E2E feature-alive: production init path constructs the service and at least one consumer reads a real verdict.
4. Ships behind `monitoring.sessionActivityVerdict` (developmentAgent pattern: live on echo+codey, dark fleet), consumer migrations individually flagged.

## Open questions — RESOLVED at convergence (Codey adversarial review, PR #845)

1. **TTL/staleness → 5s on-demand memo, per-session key, single input bundle + single `asOf` per window.** Not a global per-tick cache. Destructive/user-facing consumers may reject an expired memo as `unknown` or force-refresh. (See sampling contract above.)
2. **`stalled` debounce → in the service as a reported FACT ("sustained no-progress for N samples/duration"); action thresholds stay per-consumer.** A shared action threshold driving every consumer would recreate the overreach being removed.
3. **Codex/gemini parity → `idleAtPrompt: null` accepted for v1 with the explicit conservative rule:** null prompt-shape never produces positive `idle-at-prompt`; progress signals may prove `working`/`stalled` only; destructive paths see `unknown`→keep (current reaper posture for those frameworks).

## Build-gate test checklist (failure modes the review requires covered)

- [ ] Expired memo rejected as `unknown` by a destructive consumer; force-refresh path; sample-changed-after-memo invalidation.
- [ ] Two consumers in one 5s window receive the SAME verdict from one input bundle (CPU-delta single-writer).
- [ ] Reaper migration is behavior-preserving: every authority guard (protected/recovery/pending-injection/recent-user/open-commitment/structural-long-work) still vetoes with the shared verdict in place.
- [ ] Receipts: completion-without-relay — `idle-at-prompt` after a user message with no reply-marker does NOT suppress as "finished".
- [ ] Unknown matrix: one test per consumer row above.
- [ ] `idleAtPrompt: null` + zero CPU + no sustained no-progress ⇒ `unknown`, never `idle-at-prompt`.
