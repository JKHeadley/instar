# Standby-write reconciliation — ownership-scoped write admission + typed refusal (P2-6 / F9)

<!-- bump: minor -->

## What Changed

The multi-machine mesh ran two contradictory write models at once: the
one-awake model flips the WHOLE StateManager read-only on every non-lease-holder
(one process-wide boolean), while the active-active session pool deliberately
places owned, serving sessions on those same "standby" machines. F9's sharpest
line: a machine can be read-only ("standby") while actively OWNING pool topics —
so its writes about sessions it owns and serves were blocked
(`[SessionManager] Failed to record build context … StateManager is read-only`),
and every added machine became a standby-shaped writer-that-can't-write.
Separately, the P2-6 family showed mutating routes (`POST /evolution/actions`,
`POST /attention`) hanging open-endedly instead of refusing.

Per `docs/specs/standby-write-reconciliation.md` (review-converged round 3,
approved), writes are now classified into a write **domain**
(machine-local / session-scoped / topic-scoped / cluster-shared) by a single
source of truth (`WriteDomainRegistry`) and admitted by ONE synchronous
in-memory decision point (`WriteAdmission` — no fs/network/LLM on the admission
path; p99 < 1ms pinned by test):

- **machine-local** writes admit EVERYWHERE — even on a read-only standby (the
  F9 fix: the per-machine build-context write is no longer blocked).
- **session-/topic-scoped** writes admit iff THIS machine owns the record per
  the session-pool FSM's single-owner guarantee (boot-warmed `OwnershipIndex`
  + onCommit hook on BOTH ownership substrates); a not-owner refusal NAMES the
  owner.
- **cluster-shared** keeps byte-identical authority to today: holder admits,
  standby refuses.
- Every inadmissible write gets a **typed, machine-readable 409 refusal**
  (`error/code/domain/scope/owner/leaseHolder/asOf/retryable` + `Retry-After`)
  in well under 2s — never a hang; refuse-before-touch (a refused write mutates
  nothing). The legacy read-only message string is preserved for log scraping.
- `SessionBuildContextStore` re-keyed per machine (§3.3) with a one-time
  lease-holder legacy-key cleanup; `FileClassifier` sync exclusions for
  attention-items + evolution (the second convergence axis).
- Observability: `GET /write-admission` (mode, per-domain counters, recent
  refusals, ownership-index stats) + an event-loop-lag gauge on the AUTHED
  `/health` extension only. Refusal storms raise exactly ONE deduped attention
  item (burst invariant pinned by test).
- Ships dev-gated dark (`multiMachine.writeAdmission` — enabled OMITTED →
  resolveDevAgentGate) AND dryRun-first with a §9.14 double latch: config
  `dryRun:false` alone grants NO refusal authority until the write-surface
  inventory constant is flipped in code. On the fleet nothing changes; the
  legacy blanket guard keeps enforcing until graduation. Rollback: set
  `multiMachine.writeAdmission.enabled` to false (or leave the gate dark).

## What to Tell Your User

<!-- audience: agent-only, maturity: experimental -->
- **My machines no longer block their own homework (experimental, dark)**: when
  I run on more than one machine, a machine that isn't "in charge" used to be
  forbidden from writing ANY of its own notes — even notes about conversations
  it was actively serving. Now each write is checked against who actually owns
  that piece of work: notes about this machine's own work always go through,
  notes about work another machine owns are politely declined with a clear,
  fast "machine X owns this, retry shortly" answer instead of hanging forever.
  Nothing changes on your setup yet — this ships dark and observation-first,
  and I can turn it on deliberately when it has soaked.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Ownership-scoped write admission (dev-gated dark, dryRun-first) | `multiMachine.writeAdmission` in `.instar/config.json` (enabled omitted → live on dev agents, dark on fleet) |
| Typed 409 write refusal with Retry-After | Automatic on inadmissible writes when live; body carries code/domain/owner/leaseHolder |
| Write-admission observability | `GET /write-admission` (Bearer; 503 when dark) |
| Event-loop-lag gauge | Authed `GET /health` extension only |

## Evidence

- Root cause grounded live (2026-07-02, Laptop stderr): `[SessionManager]
  Failed to record build context … StateManager is read-only (this machine is
  on standby). Blocked: set` — a write about a session this machine OWNS,
  blocked by the blanket lease boolean (F9).
- Spec converged round 3 (0 MUST-FIX / 0 SHOULD-FIX; external gemini-2.5-pro
  CONVERGE), approved under standing Session-A preapproval (topic 29836).
- All three test tiers shipped and green: unit (110 tests — §3.2 verdict table
  both sides, typed-refusal contract, ownership-index parity on BOTH
  substrates, registry I9 story validation, StateManager one-way attach +
  fail-toward-today, conformance ratchet + write-surface inventory baseline),
  integration (13 tests — P2-6 family 201s on a standby-that-owns, typed 409 +
  Retry-After through the real HTTP pipeline in <2s, refuse-before-touch store
  snapshot, dark = 503), e2e lifecycle (8 tests — production init path,
  live-on-dev 200 / fleet-dark 503, §9.14 double latch at the production
  constant, F9 fix alive end-to-end, burst invariant ≤1 attention item).
- I2 hard properties pinned by test: ZERO fs on the admission path (including
  negative lookups) and p99 < 1ms over 10k evaluate calls.
