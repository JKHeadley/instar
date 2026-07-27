# Convergence Report — Periodic Goal Re-Alignment

## Convergence verdict

**Converged after 6 rounds at reviewed design revision SHA-256
`dbaaf58607a3229a927a1b6ae7b529307b9e1347228876a05dc1c2597c86ac91`.**

The convergence script subsequently added only its review metadata to frontmatter,
and `status` moved from `draft` to `converged`; the reviewed design body did not
change.

The final round produced zero material findings from all six required internal
perspectives: security, adversarial, scalability/performance,
integration/deployment/multi-machine, decision-completeness, and
lessons/foundation. A real GPT-tier external reviewer (`codex-cli:gpt-5.5`) ran in
every round. Its final remaining objections are explicit design disagreements, not
unaddressed correctness defects: it prefers operator escalation and longer-lived
non-initiating goals, while the converged v1 deliberately favors false-negative
precision and pull-visible status over paging the operator from a semantic advisory.

No implementation was performed. This report covers the spec and its ELI16 companion
only.

## Cross-model and ceremony disclosure

- **Cross-model review:** `codex-cli:gpt-5.5` succeeded in all 6 rounds.
- **Clean-door Anthropic:** attempted in round 2; unavailable
  (`no-supported-framework`). It is not counted as cross-family review.
- **Gemini:** not advertised by detect-all on this machine.
- **Internal reviewers:** three parallel review sessions covered two named
  perspectives each. The collaboration runtime did not expose a more specific model
  ID, so the report does not invent one.
- **Standards-Conformance Gate:** invoked with the live spec markdown in every round.
  It was unavailable every time because the running server resolves the constitution
  to the wrong checkout:
  `/Users/justin_instar_1/.instar/agents/instar-codey/docs/STANDARDS-REGISTRY.md`
  (`ENOENT`). Round 2 also rejected the managed-worktree absolute path as outside its
  configured `specsDir`; the required raw-markdown retry reached the same constitution
  error. No round is reported as zero flags.

## ELI10 overview

Long autonomous work can keep completing reasonable tasks while the overall direction
drifts away from what the operator asked for. This design gives the run a structural
"zoom out" check against sender-authenticated operator messages, rather than letting
the run grade itself against its own possibly drifted summary.

The review changed the original draft substantially. It no longer assumes a verified
history store already exists, no longer spends one LLM call every hour on unchanged
input, no longer treats three repeated model labels as independent evidence, no
longer writes to the session-owned run file, no longer cites the user-facing
heartbeat as an idle injector, and no longer creates an operator attention item.

The final result is source-cited and conservative. `diverged` requires positive,
validated evidence that the current plan contradicts or abandons an active operator
priority. Missing, incomplete, stale, malformed, or unavailable evidence is
`indeterminate`. The same unchanged source and focus produce no new call or nudge.
The agent receives a system-authored advisory at session start or a safe idle
boundary and records its own full-context disposition. The model that detects a
possible problem never becomes blocking authority.

## Original vs. converged

| Area | Original draft | Converged design |
|---|---|---|
| Digest source | Assumed durable verified store | New closed provenance contract; indexed/paginated; explicit completeness; router-authoritative proxy |
| Principal | Current mutable topic binding | Immutable topic/run-scoped opaque principal captured from authenticated registration evidence |
| Seven-day window | Rolling source of truth | Initiating directive pinned; other priorities expire from active authority; expiry is pull-visible |
| Digest grounding | Timestamp only | Relational citations with exact quotes, deterministic IDs, strict validation |
| Verdict | Forced 3 labels | Adds `indeterminate`; diverged requires two-sided positive contradiction evidence |
| Cadence | Reviewer call every tick | Timer is eligibility wake-up; unchanged source/focus means zero calls |
| Run evidence | Goal + task-list tail | Canonical registration baseline, complete bounded task/progress evidence, semantic ordered focus hash |
| Delivery | Heartbeat-shaped nudge | Framework-general internal idle adapter, stable nonce, honest bounded at-least-once semantics |
| Resume | Age-gated | Cache-only grounding per new session identity and semantic brief |
| State mutation | Open question about run-file annotation | Run file stays read-only; server-owned state + content-free rehydration recipe |
| Notification | Attention after 3 labels | No v1 operator push; unresolved state and dispositions are pull-visible |
| Routing | Claimed "off-Claude" | Registered reflector policy, exact no-Claude swap semantics, explicit no-route skip |
| Cost | Shared queue only | Pool-wide durable admission authority plus local queue, numeric caps, backoff, breaker |
| Multi-machine | Not defined | Source proxy, fenced owner, metadata-only HLC projection, transfer body barrier, WS3 prerequisite |
| Privacy | Quotes/reasons could replicate | Random opaque IDs across boundaries; quote bodies local/point-to-point only; deterministic no-LLM rehydration |

## Answers to the three original open questions

1. **State changed but operator messages did not:** do **not** rebuild the digest.
   Re-run only the reviewer when the canonical semantic focus generation changes.
   If neither source nor focus changed, reuse the cached result with zero LLM spend.
2. **CONTINUATION resume:** deliver the latest fresh cached grounding once per new
   session identity and semantic brief, without launching an LLM. This is independent
   of review cadence.
3. **Annotate the autonomous state file:** **no**. Keep the monitored file read-only.
   Persist verdict, delivery, budget, and rehydration state in a server-owned store;
   a later consumer may read that surface but may not become a second file writer.

## The four requested design challenges

### Digest sourcing

The review found the draft's largest hidden defect: no single current store preserves
authenticated UID and forwarded-message provenance through native/shared logging,
rebuild, restart, and topic movement. The converged spec makes that foundation
explicit, excludes legacy/unknown rows, anchors registration to a server-resolved
source message, uses a topic/run-scoped opaque principal ID, and fails toward
`indeterminate` when history coverage is incomplete.

### Verdict cadence

The 60-minute interval is a wake-up, not an unconditional inference schedule.
Source, focus, and brief generations are independent. Identical inputs neither spend
tokens nor advance persistence nor repeat delivery. Durable pool-wide budgets,
singleflight, coalescing, backoff, and breakers keep restart or transfer from minting
new allowance.

### Drifting/diverged false positives

Unfinished work, omitted priorities, dependency work, task order uncertainty, and
mere unrelatedness cannot become `diverged`. Divergence needs an active cited
operator priority plus explicit current contradiction/abandonment evidence. Every
quote is validated against the eligible row. Conflicting, truncated, malformed, or
uncited evidence is `indeterminate`. A repeated label over the same generation is
not new evidence.

### Off-Claude routing

"Off-Claude" is a policy preference, not a universal guarantee. Both components are
registered reflectors with non-gating attribution. They use the shipped one-step,
zero-token invocation-failure swap that excludes Claude. When no off-Claude route
exists, the feature skips unless the operator explicitly overrides that component;
it never silently consumes the active session's Claude quota.

## Iteration summary

| Round | Reviewable hash | Material findings and resolution |
|---|---|---|
| 1 | `dec878a5` | Missing canonical source/provenance; prompt laundering; stale cache; undefined verdict boundary; unconditional cadence spend; heartbeat/injection mismatch; no multi-machine state; unsafe attention semantics; 3 open questions. Full architectural rewrite. |
| 2 | `6634596a` | Added exact bounds, immutable initiating source, relational citations, legacy task parsing, semantic brief dedupe, honest delivery receipts, replicated-state privacy, transfer freshness, pool-wide budgets, WS3 prerequisite, statistically meaningful graduation. |
| 3 | `0a83d082` | Fixed idempotent binding epoch, deterministic digest IDs, expired-entry validation, point-to-point transfer of sensitive body/recipe, prompt-boundary honesty, alternatives and recall criteria. |
| 4 | `88fd0068` | Internal panel reached zero material. Security/adversarial interaction found reversible UID hashes and 24-hour body expiry stranding unchanged sessions. Replaced cross-boundary hashes with opaque IDs and added content-free deterministic brief rehydration. |
| 5 | `0583d620` | Closed HTTP hash oracle, scoped principal opaque IDs per topic/run, and separated transient source outage from permanent evidence invalidation. |
| 6 | `dbaaf586` | All six internal perspectives: zero material, signable. Cross-model reviewer repeated known policy preferences; no new correctness finding. |

## Final-round perspective verdicts

- **Security:** zero material; signable.
- **Adversarial:** zero material; signable.
- **Scalability/performance/cost:** zero material; signable.
- **Integration/deployment/multi-machine:** zero material; signable.
- **Decision-completeness:** zero material; signable.
- **Lessons/foundation:** zero material; signable.
- **External GPT-tier:** serious preference objections repeated around v1 escalation,
  seven-day expiry, and complexity. Disposition:
  - operator paging rejected because the reviewer is signal-only and false-positive
    attention is the exact risk this convergence was asked to control; high-priority
    unresolved state remains visible on the authenticated pull surface;
  - non-initiating priorities require refresh and expired counts are visible; they
    cannot silently retain divergence authority;
  - the rollout already starts single-machine, cache-only, dark/dry-run, while the
    implementation contract remains unified from birth so a staged v1 does not ship a
    machine-blind foundation;
  - existing queue, handoff, HLC, ownership, and election primitives are reused; no
    workflow engine is introduced.

## Decision-completeness

All 18 build-time choices are frontloaded in the spec. There are no
`cheap-to-change-after` tags and no unresolved open questions. The choices involving
identity, money, durable state, provider egress, user-visible delivery, and
multi-machine behavior are explicitly treated as non-cheap.

## Approval boundary

This convergence stamp is review evidence, not approval and not implementation
authorization. The script does not write `approved: true`. The spec is ready for
operator review/signature; implementation remains a separate lane.
