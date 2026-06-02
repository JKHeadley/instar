---
schema: apprenticeship-retro-harvest/v1
instanceType: mentorship
from: echo
to: codey
framework: codex-cli
harvestedAt: "2026-06-02T03:30:00Z"
scopeMode: full
completeness: partial-accepted
sourcesCovered:
  ledger: { read: true, issueCount: 28 }
  playbook: { read: true, entryCount: 11 }
  memory: { read: true, files: 35 }
  threads:
    - { id: 13435, fromTs: "2026-05-26T00:00:00Z", toTs: "2026-06-02T03:30:00Z", messagesRead: 220, truncated: true }
    - { id: 458, fromTs: "2026-05-26T00:00:00Z", toTs: "2026-06-02T03:30:00Z", messagesRead: 60, truncated: true }
  prs: [653, 656, 658, 666, 669]
counts: { lessons: 10, metaLessons: 5, processInsights: 5 }
seededToPlaybook: []
redaction: { scrubber: "correction-scrub@v1", findingsRemoved: 0, scrubbedAt: "2026-06-02T03:30:00Z" }
fidelityReview:
  reviewer: "claude-opus-fidelity-independent"
  verdict: "partial"
  at: "2026-06-02T03:32:00Z"
  audit:
    sampledLedgerIds: [eec69291, d533641d, 8525cd16, 864248ca, 01676b4e, 40161885, 0338aa38, 5c910c16, 79daeffa, 9ab5146b, 2b7dc8e5, d2a54f2e, a9fffc56, c2f0fc35]
    ledgerResolution: "14/14 cited ledger pointers resolved; 14/14 exact title/bucket match after the c2f0fc35 reword. No fabricated/unresolvable ids."
    watermarkCheck: "ledger actual=28 vs claimed 28 (exact); playbook actual=11 vs claimed 11 (exact)."
    classification: "sound — 5 meta-lessons genuinely cross-framework, 10 lessons correctly framework-specific; anti-skew satisfied."
    redaction: "clean — pointers-only, no secrets/PII."
  gaps: "Telegram threads 13435/458 are sampled, not exhaustively re-read message-by-message (frontmatter flags truncated:true / completeness partial-accepted); their high-signal content is captured via the ledger + memory, so the gap is depth-of-re-read, not lost signal. Accepted pending Justin's nod."
acceptedBy: justin
acceptedAt: "2026-06-02T04:33:00Z"
programNeeds: 5
---

# Retro-Harvest — Echo → Codey (codex-cli mentorship)

The first retro-harvest: the distilled learnings from Echo mentoring Codey onto Instar
(the codex-cli onboarding), produced per `RETRO-HARVEST-PROCEDURE.md`. The harvest doc is
the authoritative store for the meta-lessons + process-insights below; framework-specific
lessons live in the ledger and are referenced by pointer.

**Coverage note (partial-accepted):** the ledger (28 issues) and the framework-issue playbook
(11 entries) were read in full; the memory was mined for the codex/Codey/mentorship/process
subset (~35 of 317 files); the Telegram threads (13435, 458) were sampled, not exhaustively
re-read message-by-message — their high-signal content is already distilled into the ledger +
memory, so the gap is depth-of-re-read, not lost signal. Named gap accepted pending Justin's nod.

## Lessons

- Codex `exec` runs ONE turn then exits — no native Stop-hook-driven multi-turn loop, so codex can't sustain autonomous multi-turn work without a synthesized loop driver. ledger:eec69291
- Codex rejects ANY non-JSON on a Stop hook's stdout ("invalid stop hook output") — the hook-stdout contract is strict. ledger:d533641d
- Codex emits no SubagentStart/Stop lifecycle events — a capability that is FALSE for the framework, so SubagentTracker-based features are blind. ledger:8525cd16
- Thread/TopicResumeMap `jsonlExists` was Claude-only → `get()` returned null for every codex session (resume continuity silently broken). ledger:864248ca
- SessionWatchdog was claude-PID/pane-only → an 8.5h-hung codex `exec` job went undetected. ledger:01676b4e
- RateLimitSentinel was codex-blind in both detection and recovery-verification (it keyed on claude pane strings). ledger:40161885
- CompactionSentinel recovery-verification was codex-blind → it re-injected into sessions that had not actually recovered. ledger:0338aa38
- Codex token windows overcount: the summary sums cumulative long-lived-session usage rather than the active window. ledger:5c910c16
- Relay duplicate-reply on codex: MCP retries emit a fresh event id per attempt, defeating id-based dedup. ledger:79daeffa
- Codex hook trust-flow did not trust the newly-armed autonomous Stop hook → the autonomy loop failed to self-sustain. ledger:9ab5146b

## Meta-lessons

- The real work of onboarding a framework IS the runtime adapter (process spawn, the hook-stdout contract, a synthesized multi-turn/Stop loop driver, compaction-signal synthesis, native-module ABI), NOT the agent-facing primitive layer — codex reached full agent-facing parity while every remaining defect was runtime-layer. This directly predicts where Codey→Gemini will hit friction. ledger:eec69291
- Any structural detector keyed on a framework's PID / tmux-pane / output-string signature is silently blind to the next framework — three independent sentinels (watchdog, rate-limit, compaction) all failed the same way. Audit every signature-keyed detector before onboarding. ledger:01676b4e
- Functional/structural parity is NOT behavioral parity: every primitive can render correctly and the agent still "struggles in the wild" because of integration defects no structural check catches. ledger:2b7dc8e5
- A framework's hook-stdout contract is a hard integration boundary — assumptions that "any output is fine" break (codex rejects non-JSON). Treat the hook I/O contract as a first-class adapter surface. ledger:d533641d
- A non-Claude framework can make AND verify fixes but stalls at the `/instar-dev` ship-gate — the ship path itself is a parity surface the mentee must be able to traverse, or it cannot build its own adapter. ledger:d2a54f2e

## Process-insights

- The dual-vantage loop — drive the mentee as a user over Telegram, then read its logs/internals as a developer — finds root causes a whole parity project misses (a 20-minute root-cause vs a missed structural audit). thread:13435#dual-vantage
- test-as-self proves the mentee can USE every primitive; having it MENTOR proves it INTERNALIZED them — a strictly higher parity bar, and the thesis of the apprenticeship. thread:13435#test-as-self
- Stage-A leak: driving the mentee with knowledge it could not have seen contaminates the observation — keeping the mentee's information boundary clean is a hard mentor discipline. ledger:a9fffc56
- Inbound to a BUSY mentor session is stranded as an unsent draft and silently dropped — mentor continuity breaks unless a warm/persistent per-thread session can absorb inbound without dropping it. ledger:c2f0fc35
- Long async-external blocks must be durably tracked AND surfaced to the user; a silent middle reads as a stall even when work is progressing. thread:13435#silent-stall

## What the program needs

- need-001 (motivatedBy: thread:13435#dual-vantage, priority: high) — a differential read-channel so the overseer sees the mentee's raw streams directly, not only the mentor's reports.
- need-002 (motivatedBy: ledger:2b7dc8e5, priority: high) — a doc-as-required-artifact gate: issues found by hand must reach the ledger before an instance closes (behavioral defects evaporate otherwise).
- need-003 (motivatedBy: ledger:01676b4e, priority: high) — a framework-blind-detector audit run BEFORE onboarding: every PID/pane/string-keyed detector checked against the new framework's signature.
- need-004 (motivatedBy: ledger:d2a54f2e, priority: med) — a non-Claude `/instar-dev` ship path so Codey can actually ship the Gemini runtime adapter it builds.
- need-005 (motivatedBy: ledger:c2f0fc35, priority: med) — a warm/persistent per-thread mentor session that absorbs inbound to a busy session instead of stranding it as a dropped draft.
