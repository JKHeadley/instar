---
title: "Cartographer Doc-Freshness Enforcement"
slug: "cartographer-doc-freshness"
author: "echo"
parent-principle: "Documentation IS Being"
eli16-overview: "cartographer-doc-freshness.eli16.md"
status: "approved"
approved: true
project: "cartographer-conformance"
spec_number: 2
depends-on: "cartographer-doc-tree-schema (spec #1)"
review-convergence: "2026-06-10T07:44:00.660Z"
review-iterations: 4
review-completed-at: "2026-06-10T07:44:00.660Z"
review-report: "docs/specs/reports/cartographer-doc-freshness-convergence.md"
---

# Cartographer Doc-Freshness Enforcement

> Spec #2 of `cartographer-conformance`. Builds directly on spec #1's
> `CartographerTree` (the schema, the `staleNodes()` git-hash detector, the
> in-process `setSummary()` write path, the `provenance` field). The
> enforcement-model tension was **settled with the operator** (topic 22726): a
> **three-tier hybrid**, NOT node-granular-hard-gate vs. CI-ratchet as an
> either/or. This spec specifies the tiers + the efficiency contract that keeps
> the sweep from becoming a load source.
>
> **Convergence note (round 1):** the first draft framed the sweep as a spawned
> scheduler `JobDefinition`. Review caught that as **unbuildable** — a spawned
> session cannot reach the in-process `setSummary()`, the in-process `LlmQueue`,
> or `componentFrameworks` routing (all in-process-only). The converged design
> makes the sweep an **in-process server-side poller** (the `TokenLedgerPoller` /
> `PromiseBeacon` pattern). That single change also dissolves the cross-process
> single-writer race.
>
> **Convergence note (round 2):** an abbreviated cross-model convergence (5
> internal reviewers — security, scalability, adversarial, integration,
> lessons-aware; GPT/codex CLI unavailable on the host and Gemini's API errored,
> so externals were skipped per the abbreviated-convergence rule) surfaced ~25
> material findings, two of them **critical at the foundation layer**:
> **(C1)** the live `IntelligenceRouter` *defaults to falling back to Claude*
> when the off-Claude framework is absent — so the "never spends Anthropic quota"
> guarantee was FALSE as written; **(C2)** spec #1's `CartographerTree` is not yet
> on `main`, so every primitive this spec calls is an assumed contract. Round 2
> closes both (a routing **probe-and-refuse** invariant + a pinned **Foundation
> contract** section + a hard **merge-order gate**), plus: lease-gating the author
> path so an active-active fleet doesn't N× the spend/egress; making the quality
> validator **deterministic** instead of a weak model grading itself; treating
> summaries as untrusted **on output** (they are read by spec #5's navigator);
> an explicit **egress-acknowledgement** gate distinct from `enabled`; and making
> the CI ratchet surface the un-authored/quarantined backlog so a green ratio
> can't hide local rot.

## Problem statement

Spec #1 gives every node a summary + a git fingerprint and can tell, for free,
which nodes are stale (`staleNodes()`). But a freshly-scaffolded tree is all
`never-authored`, and as code changes nodes drift `stale`. Something has to
*author* and *re-author* summaries — and do it without becoming the exact
token-burn / CPU-starvation / breaker-storm load source Instar keeps fighting
(`finding_llm_circuit_breaker_storm_background_features`: background LLM features
tripped the global breaker 96×/day, pausing ALL gates). The naive design (a job
that re-summarizes the whole codebase every run) is precisely that footgun.

The operator-settled model is three tiers, each cheap, none a dismissible human
gate:

1. **Inline (opportunistic)** — when an agent touches code, it refreshes the node
   it touched, in the same change. Cheapest; covers the hot path; node-granular
   freshness done *by* the agent, not gated *on* a human.
2. **Sweep poller (the gap-filler)** — a cadenced in-process poller that finds
   nodes that went stale via paths tier 1 missed (other agents/frameworks, direct
   edits, commits where nobody updated the node) and freshens them. This is what
   makes the map *self-healing* rather than *self-updating-when-someone-remembers*.
3. **CI ratchet (floor)** — aggregate freshness can only hold or rise, never
   backslide; the alarm if tiers 1+2 fall behind.

## Foundation contract (assumed from spec #1) — round 2

This spec is built ENTIRELY on spec #1 primitives. Per lesson L3 (*topology check
before convergent review*) and B6/B9 (*verify runtime state before building on
it*), the exact contracts this spec depends on are pinned here so a mismatch is
caught at review, not at build. **Merge-order gate (hard):** spec #2 MUST NOT
merge before spec #1 (PR #1041) is on `main`; CI for spec #2 imports
`CartographerTree`, and a defensive unit test asserts the top-level `cartographer`
`SHARED_DEFAULTS` key exists before `freshnessSweep` is read.

| Primitive (spec #1) | Assumed signature / behavior |
|---|---|
| `staleNodes()` | returns `stale ∪ never-authored`; `path-gone` flagged separately; derived from ONE batched `git ls-tree`. |
| `setSummary(path, summary, opts)` | in-process write; `opts.provenance` accepted + persisted on the node; bumps `summaryUpdatedAt`. |
| node record | carries `codeOid` (fingerprint), `summary`, `summaryUpdatedAt`, `provenance`, `status` (`fresh`/`stale`/`never-authored`/`path-gone`). Round 2 ADDS (this spec owns these fields if spec #1 lacks them): `childDigestHash`, `staleSincePass`, `consecutiveAuthorFailures`, `lastAuthoredBy`, `confidence`. |
| `?path=` validator | repo-relative; rejects leading `/`, `..`, encoded traversal (`%2e%2e`, `..%2f`), absolute/Windows paths; resolves symlinks; node must already exist. |
| committed-state read | content + fingerprint read from the **committed blob** (`git show HEAD:<path>`), never the dirty working tree. |
| storage | `.instar/cartographer/` is gitignored (per-machine). |

This spec also depends on an existing (non-spec-#1) module — pinned here for the
same reason (round 3):

| Primitive (`IntelligenceRouter` / `componentCategories`) | Assumed signature / behavior |
|---|---|
| `router.for(component, categoryOverride?)` | diagnostic resolver → `{ component, category, framework, available }`. **`available` is hardcoded `true` when `framework === defaultFramework`** (so a resolve-to-Claude is reported "available"); the off-Claude refusal must test `framework`, not `available`. |
| `router.evaluate(prompt, { attribution: { component, category } })` | per-call options carry `attribution` (and `model`/`maxTokens`/…) — **NO per-call `fallback` field.** |
| `componentFrameworks.fallback` (operator-global config, read live via `resolveConfig()`) | `'default'` (the default) degrades a binary-missing framework to Claude; `'none'` makes `evaluate()` THROW instead. Set globally by the operator — the poller CANNOT pass it per-call. |
| `categoryForComponent(name)` | unregistered name → `'other'` → resolves to `defaultFramework` (Claude). `defaultFramework` is `claude-code` unless configured. |

If any signature differs when these are read at build, that is a round-3+ finding
to fold in before approval — not a build-time surprise.

## Proposed design

### Naming: `fresh` means fingerprint-current, NOT verified-correct — round 2

A node is `fresh` **iff its `codeOid` matches HEAD** — i.e. *the summary was
authored against the current code*. `fresh` does **NOT** assert the summary is
*correct*; a plausible-but-wrong summary that passed the validator over unchanged
code stays `fresh` until the code changes. The system therefore:

- surfaces `lastAuthoredBy` (`inline-agent` | `sweep:<framework>`) and a coarse
  `confidence` per node, so consumers and the ratchet never read "git-current" as
  "trustworthy";
- has the sweep **periodically re-validate a small sample of `fresh` nodes**
  (`revalidateSamplePerPass`, default 2, oldest-`summaryUpdatedAt` first) so a
  one-time bad author isn't immortal. Re-validation calls are **debited against
  the SAME `maxNodesPerPass` / `maxCentsPerPass` ceilings and the CPU gate** as
  authoring (skipped first when curtailing, skipped entirely below the critical
  break) — it is bounded, never additive to the per-tick budget, so it can't be a
  load source. This sampled path — NOT the main author loop — is also the only
  place a still-`fresh`-at-HEAD node is ever re-examined (the author loop skips
  any node whose `codeOid` matches HEAD, inline or sweep-authored alike, so a
  correctly-fresh inline node is never re-authored just for being inline);
- states the **hard consumer contract** (binding on specs #3/#5): a summary is a
  **hint to re-ground against code**, never an authority. See §Security for why
  this is also a safety boundary, not just a quality one.

### Tier 1 — Inline opportunistic refresh

A thin, cheap affordance, not a gate:

- A single authenticated **write route** `POST /cartographer/node/refresh`
  `{ path, summary }` (Bearer-auth, 503 when disabled) so an agent that just
  edited code can refresh that one node's summary itself. (Spec #1 kept all
  routes read-only; tier 1 is the *one* deliberate write surface, single-node,
  idempotent, behind auth + the enable gate.) It calls spec #1's in-process
  `setSummary()`.
- **Path validation.** The route applies spec #1's full `?path=` validation
  (incl. encoded-traversal forms, per the Foundation contract) BEFORE deriving
  the node slug: repo-relative, no leading `/`, no `..`, must already exist as a
  node (→ 400 otherwise). A write route is strictly more dangerous than a read
  route — this guarantees it can only ever target a known scaffolded node and
  never create an arbitrary file from request input. `summary` is length-bounded.
- **Quality bar parity (round 2).** Inline writes are subject to the **same
  deterministic validity check** the sweep uses (§Tier 2.9): the summary must
  reference ≥1 symbol/identifier actually present in the covered code (cheap,
  non-LLM). A submission that fails is rejected (400) — the inline path is NOT a
  lower-validation backdoor than the sweep. (Rationale: a write route that
  persists verbatim text other agents later read is the most dangerous surface in
  the feature; it cannot validate *less* than the background path.)
- **Precedence (round 2).** Inline summaries are recorded
  `provenance.source: 'inline-agent'` and are NOT treated as protected ground
  truth: the sweep MAY re-author an inline node on a later pass (they do not
  permanently win over a validated model author). This closes the "a confused or
  injected inline write wins until the code changes and poisons parent rollups"
  hole. A modest per-route write-rate bound protects the single in-process writer.
- **Content neutralization (round 2).** Before persist, instruction-shaped
  content in the summary is neutralized/flagged (see §Security — summaries are an
  injection vector into spec #5's navigator, on output as well as input).
- A CLAUDE.md affordance (Agent Awareness): "when you finish editing a subsystem,
  refresh its cartographer node so the map stays true." (Drafted in §Migration.)
- This tier authors NO LLM call by itself — the agent supplies the summary it
  already knows from the edit it just made. Zero background cost.

### Tier 2 — The efficient sweep POLLER (the heart of this spec)

**Execution model (converged): an in-process server-side poller**, `CartographerSweepPoller`
— constructed in `server.ts` beside `TokenLedgerPoller` / `PromiseBeacon`, driven
by a cadence. It is **NOT** a spawned scheduler `JobDefinition` (a spawned session
can reach none of the in-process `setSummary()`, `LlmQueue`, or routing). Ships
**dark** behind `cartographer.freshnessSweep.enabled` (rides the existing
`cartographer.enabled` master gate); a no-op when either is off.

**Lease-gating — multi-machine (round 2, CRITICAL).** This agent runs
active-active across machines, and in-process pollers (`TokenLedgerPoller`,
`PromiseBeacon`) are NOT standby-gated — only the *scheduler* is. So a raw poller
on N machines would each detect, author, and re-send the SAME source N times: N×
the LLM spend AND N× the source-code egress (the in-process `LlmQueue` daily cap
is per-process, so it bounds each machine to the cap, i.e. N× the cap fleet-wide).
**Invariant:** the **author path runs ONLY on the lease holder**
(`coordinator.holdsLease()`); standby machines may run cheap-detect for local
read-locality but author **zero** nodes and make **zero** LLM/egress calls. A
multi-machine test asserts a standby instance authors zero nodes.

**Reentrancy (round 2).** A `running` flag (the `TokenLedgerPoller` pattern) is
set at tick entry and cleared in `finally`; a tick that fires while the prior one
is still running is **skipped and logged**. Without this, slow off-Claude CLI
author calls could stack ticks into concurrent sweeps — the exact load-source
shape this spec exists to prevent.

Per tick (on the lease holder), the poller:

1. **Cheap detect (no LLM).** Calls `staleNodes()` (spec #1 — one `git ls-tree`).
   Candidate set = `stale ∪ never-authored`. **Staleness is ALWAYS re-derived
   from git here — never served from the cursor.**
2. **Order children-before-parents.** Candidates are ordered **deepest-first for
   BOTH `stale` and `never-authored`** (a `stale` parent authored before its
   `stale` children reads stale child summaries and records itself `fresh`,
   propagating stale content UP). A dir node is authored only after its
   currently-`stale`/`never-authored` descendants are fresh or scheduled earlier
   in the same pass; otherwise the dir is **held over to a subsequent pass** (stays
   stale — honest). This is the runtime ordering mechanism, not a unit of postponed
   work. Anti-starvation: per-node `staleSincePass` (stored **on the node**, not the
   cursor — see §10); a dir held over more than `maxDeferredPasses` (default 5) passes is
   biased forward, but the front-bias lane may consume **at most half** of
   `maxNodesPerPass` so a churny subtree cannot starve the rest of the tree.
3. **Bound per tick — by BOTH node count AND spend (round 2).** Authors at most
   `maxNodesPerPass` (default 25) candidates AND at most `maxCentsPerPass`
   (default = `dailyBackgroundCents / expectedTicksPerDay`) of estimated spend,
   whichever binds first. This stops one tick from draining the whole day's
   background budget in a burst and then flapping the breaker all day. A `log()`
   line names how many were left (no silent truncation). **Convergence
   condition:** the drain rate `min(maxNodesPerPass, budgetNodes) / cadence` must
   exceed the expected stale-arrival rate; if the backlog grows for
   `staleBacklogGrowthTicks` consecutive ticks the poller surfaces it (§Brakes).
4. **Dir re-author amplification guard.** One leaf edit flips the tree-oid of
   every ancestor dir, which would force an O(depth) chain of dir re-authors per
   leaf edit. Mitigation: a dir is re-authored **only when its direct children's
   summaries actually changed**, via `childDigestHash` (a cheap hash of the
   concatenated direct-child summaries) **stored on the node** so it survives
   across ticks. A dir whose tree-oid flipped but whose `childDigestHash` is
   unchanged (e.g. a comment-only deep edit) has its fingerprint refreshed
   **without an LLM call**. (Accepted limitation, stated: a holistic dir-level
   change not reflected in any child summary's text is not re-authored until a
   child summary changes — the fingerprint still tracks code; the trade buys the
   amplification win.)
5. **Author with a LIGHT model, routed OFF Claude — with a routing PROBE
   (round 2).** For each leaf candidate, read the covered code from the
   **committed blob** (bounded — §Input cap); for each dir candidate, read its
   **direct child summaries**, re-delimited as untrusted data (§Security). Ask a
   **`light`/`fast` model tier** (framework-agnostic — NEVER a vendor model name)
   via `IntelligenceRouter.evaluate()` with
   `attribution: { component: 'CartographerSweep', category: 'job' }`.
   **The off-Claude guarantee is enforced by a probe, not an assumption:** the
   live router defaults `(cfg.fallback ?? 'default')` to running on Claude when
   the routed framework is unavailable — so three silent paths land on Claude
   (missing `componentCategories` entry; `componentFrameworks` not mapping `job`
   off-default; the binary missing). To close all three, at construction and on
   each tick the poller calls the router's resolver
   **`router.for('CartographerSweep')`** → `{ component, category, framework,
   available }` (the real `IntelligenceRouter` diagnostic resolver — see the
   Foundation contract; NOTE: when a component resolves to the Claude default the
   router reports `available: true`, so the refusal MUST test the `framework`
   field, not `available` alone). The poller **refuses to author (leaves nodes
   `never-authored`, trips the breaker, reports once) if `framework` is the Claude
   default framework OR `available` is false**, unless `allowClaudeFallback: true`
   (default false). This single `for()` probe closes BOTH off-Claude paths: the
   `framework === default` check guards resolve-to-Claude, and `available === false`
   guards binary-missing (for a non-default framework, `for()` reports `available:
   false` exactly when its provider/binary is absent). Because the probe runs at
   the START of each tick before any author call, a missing binary is caught
   before egress. (NOTE — `fallback` is **not** a per-call option the poller can
   set; it is the operator-global `componentFrameworks.fallback`, default
   `'default'` = degrade-to-Claude. To also hard-close the tiny window where a
   binary vanishes BETWEEN the tick probe and the author call, the operator MAY set
   `componentFrameworks.fallback: 'none'` so `evaluate()` throws; even without it,
   the next tick's probe + the breaker surface a vanished binary rather than
   silently authoring on Claude across ticks. This is a documented deployment
   precondition, not a per-call mechanism.) Result written via
   `setSummary(path, summary, { provenance: { source: 'sweep', framework, modelTier: 'light' }, lastAuthoredBy, confidence })`.
6. **Input cap.** A leaf author reads at most `maxLeafBytes` (default 24 KB) of
   committed content; a larger file is **head-truncated and marked `oversized`/
   `partial` in provenance** (no unbounded "structural sketch" preprocessing) so
   one pathological generated/minified leaf can't blow a call's or the day's
   budget, and consumers know the summary is non-comprehensive.
7. **Author only from committed state.** Both the staleness **fingerprint** AND
   the **content** sent to the summarizer are read from the committed blob
   (`git show HEAD:<path>`), never the dirty working tree — so an uncommitted edit
   (possibly containing just-typed secrets) is never transmitted, and a long-lived
   uncommitted edit never causes perpetual re-author churn.
8. **Budget + pressure gated, re-sampled mid-tick (round 2).** Every author call
   goes through the in-process `LlmQueue` on the **`background`** lane. CPU
   pressure is read via a shared `getHostPressure()` sampler and **re-sampled
   between author calls within a tick**, not only at tick entry: at
   `cpuModerateLoadPerCore` the poller curtails to `minNodesUnderPressure`
   (default 3); if pressure crosses `cpuCriticalLoadPerCore` mid-tick it **breaks
   out of the author loop immediately** (a tick that authors 25 slow CLI calls can
   span a load spike). **`LlmAbortedError` is backpressure, not failure**
   (round 2): the `background` lane is preempted when interactive work arrives —
   an aborted author does NOT count toward the breaker or per-node quarantine, the
   node keeps its prior status and is retried next quiet tick, and a partial spawn
   isn't double-charged. (Without this, a chatty user trips the sweep's own
   breaker purely from preemption.)
9. **Quality bar = DETERMINISTIC first, LLM advisory only (round 2).** Before
   `setSummary`, the poller validates each authored summary with a **deterministic
   check**: non-empty, within `[minSummaryChars, maxSummaryChars]` (a length
   **floor**, not just a cap), AND **≥1 symbol/identifier named in the summary is
   verifiably present in the covered code** (token/AST match — NOT an LLM asking
   itself "is this valid?"). Rationale (P2 Signal vs Authority): the open round-1
   question leaned toward an LLM affirmation on the *same light tier that wrote the
   summary, over the same untrusted input* — a self-grading weak model that an
   injection payload steers in one shot. So the deterministic symbol-presence
   check is the **authority**; any LLM affirmation is an optional **signal** layered
   on top and, if used, MUST run on a *different* tier than the author. A summary
   that fails the deterministic check is **left `never-authored`** (honest) and
   logged — never written. This closes the "garbage/injected summary propagates
   UP via the child digest" and "ratchet gamed by trivial summaries" holes.
10. **Idempotent cursor — WITHIN-tick checkpoint only (round 2).** Two state
    classes are kept distinct: (a) **durable per-node metadata** (`childDigestHash`,
    `staleSincePass`, `consecutiveAuthorFailures`) lives **on the node in the
    index**, bounded by node count by construction; (b) a
    `.instar/state/cartographer-sweep-cursor.json` checkpoints **only within an
    interrupted tick** (which candidates of the current ordering were authored),
    written atomically (tmp+rename) and schema-validated on load. A
    missing/corrupt/invalid cursor **fails soft to a full re-scan**. The cursor is
    a performance optimization that **cannot exceed the per-tick caps** (budget /
    `maxNodesPerPass` / CPU) — so corrupting it (a local-trust-boundary write)
    forces at most one extra cheap re-scan, never unbounded work. It is reset each
    fresh tick and never accumulates an unbounded processed-set.

#### Brakes — No Unbounded Loops

The sweep ships all three brakes plus quarantine:

- **Cap:** `maxNodesPerPass` AND `maxCentsPerPass` (above).
- **Pressure-yield / curtail:** the CPU gate, re-sampled mid-tick (above).
- **Breaker (with RE-escalation — round 2):** after `zeroProgressTicksToBreak`
  (default 3) consecutive ticks that author **zero** nodes (model rejects every
  attempt — rate-limited / CLI broken / circuit-open / routing-refused), the
  poller **backs off its cadence** and emits **ONE** `DegradationReporter` notice.
  Per the Eternal-Sentinel rule (*never-give-up must not mean never-tell-anyone*),
  it then **re-escalates once per `breakerReescalateHours` (default 6) of
  continuous stall** — not silence forever — and the backed-off probe is
  constant-cost and **never routes to Claude** (it re-runs the §5 routing probe;
  if that still resolves to Claude/unavailable it stays in the never-authored
  path).
- **Per-node quarantine:** `consecutiveAuthorFailures` (on the node) → after
  `nodeFailQuarantineThreshold` (default 3) a node is `author-failed` (a distinct
  status surfaced in `/cartographer/health`, excluded from re-attempt for a
  backoff window). (Distinct from a node that *successfully* authors every pass but
  keeps re-staling — that churn anomaly is surfaced too, so front-bias can't hide
  it.)
- **Required test:** `sustained-failure` (permanently-rejecting author model →
  backs off, breaks, surfaces once, **re-escalates** after the window).

#### No Silent Degradation — the absent/misrouted-framework rule

Exactly **two** outcomes per author attempt: (a) a model-authored, deterministically
validated summary is written, or (b) the node is left `never-authored` and logged.
**No heuristic/templated fake summary is ever written, and the sweep never
silently runs on Claude.** The §5 routing **probe** is the L5 canary: if the
resolved framework for `CartographerSweep` is the Claude default or unavailable
and `allowClaudeFallback` is false, the poller refuses to author and reports —
rather than burning the exact Anthropic quota the off-Claude routing exists to
avoid (the background-breaker-storm shape). A Claude fallback, if ever enabled, is
**opt-in and observable** (`allowClaudeFallback`, default false), never silent.

#### Authority across the three tiers

Precedence is **last-writer-wins, keyed on `summaryUpdatedAt`**, with a
`compare-and-skip on HEAD sha` guard so a tick that read older code can never
clobber a node freshened at the current HEAD. The sweep skips nodes already
`fresh` for re-author **but may re-author inline nodes on a later pass**
(round 2 — inline summaries are not protected ground truth; see Tier 1). Both the
tier-1 route and the poller run in the one server process (§Concurrency), so this
is a single-writer in-process guarantee.

### Tier 3 — CI ratchet floor

A CI-executed script (`scripts/cartographer-freshness.mjs`) computes freshness and
**fails the build if it regresses**. Parity with `scripts/docs-coverage.mjs`
(hardcoded floor constants; gitignored output never a read baseline).

- **Signal vs Authority — why a deterministic gate IS justified here (round 2).**
  P2 says brittle detectors emit signals and intelligent gates hold blocking
  authority. The ratchet is given **blocking authority** deliberately, because it
  is **monotonic-by-construction**: its only failure mode is "freshness genuinely
  regressed below a committed floor," exactly like `docs-coverage.mjs`. The
  false-positive surface is enumerated and closed: the CI re-scaffold reads the
  committed tree-oid (no working-tree race), and the grace-window / `path-gone`
  edges are unit-tested. A transient that can't be ruled out fails *open with a
  logged warning*, not a hard red.
- **The floor is a hardcoded committed constant** (`CARTOGRAPHER_FRESHNESS_FLOOR`,
  env-overridable for local runs). Bumping it is a visible PR diff. The written
  `.instar/cartographer-freshness.json` is **output measurement only, never the
  read floor.**
- **CI input:** `.instar/cartographer/` is gitignored, so the script
  re-scaffolds from the checked-out tree (one walk + one `git ls-tree`); it
  **short-circuits via the root tree-oid** (if unchanged since the last run, the
  ratio is unchanged — skip the walk) so the per-PR cost doesn't scale badly on a
  large monorepo (the reusability target).
- **Metric — and the backlog it must NOT hide (round 2).** The ratchet ratios on
  `fresh / authorable` nodes, excluding `never-authored`-within-grace and
  `path-gone`. But a green ratio over a *small authored set* can hide a large,
  growing `never-authored`-past-grace or `author-failed` backlog (Goodhart / P14
  "temporary success hides root cause" / P18 "the schema is the perception"). So
  the script ALSO emits, and ratchets against the GROWTH of, two **absolute**
  counts — `neverAuthoredPastGrace` and `authorFailed` — surfaced alongside the
  ratio in `/cartographer/health`. A green ratio with a rising un-authored backlog
  fails the build. Node identity is content/path-stable so a rename cannot reset
  the grace clock to launder old debt.
- **Initial floor + workflow wiring (round 2).** Add a `cartographer-freshness`
  job to `.github/workflows/ci.yml` (`pull_request: [main]`,
  `node scripts/cartographer-freshness.mjs --check`, upload the measurement
  artifact). The introducing PR ships the floor at a value **achievable on the
  tree at introduction** (start near 0 and ratchet up, the docs-coverage
  "starts loose" rationale) so it can't red-fail itself.
- **No per-change human friction:** measured in aggregate, at the floor.

### Shared engine note

The cheap-detect / order / bound / curtail / validate / breaker **author loop** is
built as a reusable `CartographerSweepEngine` (with the brakes, the deterministic
quality bar, the routing probe, and the lease-gate baked in) so spec #3 (the
registry-wide conformance audit) runs it for a second purpose and inherits the
efficiency + safety invariants automatically.

## Security & data-egress

- **Prompt-injection isolation — input AND output (round 2).** Repo content is
  presented to the summarizer as **data, not instructions** (delimited). Crucially,
  a model-authored summary is *output shaped by untrusted input*, and it is later
  (a) re-consumed internally when a parent dir author reads child summaries, and
  (b) read by spec #5's navigating sub-agent as context. So: child summaries are
  **re-delimited as untrusted data** at every internal consumption point, the
  persisted summary is **scanned/neutralized for instruction-shaped content** at
  write time, and the **hard contract on #5** is that summaries are rendered as
  quoted data, never spliced into a prompt as instructions. "Consumers re-ground"
  is a safety boundary, not just a quality note.
- **Egress acknowledgement — a gate distinct from `enabled` (round 2).** Enabling
  the off-Claude sweep sends source content to the configured framework's provider,
  and over many quiet ticks transmits the **whole authorable tree** (and re-sends
  on drift). That is a real, by-design whole-repo egress to a third party. It is
  therefore gated behind an explicit, separate
  `cartographer.freshnessSweep.egressAcknowledged: false` (default) — the sweep
  **no-ops until the operator sets it true**, so turning on freshness is never
  silently turning on whole-repo third-party egress. An optional
  `egressScope: { include/exclude }` lets an operator confine egress to
  non-sensitive subtrees.
- **Secrets exclusion — concrete, tested (round 2).** Beyond spec #1's skip-set,
  the summarizer NEVER reads-and-sends a credential-bearing file. Deny-globs:
  `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.npmrc`, `.netrc`,
  `**/secrets*`, `**/*credential*`; PLUS only git-tracked, committed content is
  ever read (gitignored secret files are categorically excluded — an egress
  guarantee, not just churn-avoidance); PLUS a pre-send content tripwire (the
  existing credential-leak-detector patterns) that, on a hit, marks the node
  `content-excluded` and skips it. A Tier-1 test asserts a planted-credential file
  is never passed to an author call.
- **External-operation framing (round 2).** The sweep's off-Claude calls are
  internal `IntelligenceRouter` calls (not MCP), so they are **out of scope** for
  the `external-operation-gate` hook — stated explicitly (L11) rather than left
  unengaged; the egress-acknowledgement gate above is the operator-consent surface.
- **Ratchet floor integrity.** The floor is a committed constant — not lowerable
  without a reviewable diff.

## Concurrency (single-writer — resolved by the in-process model)

Both the tier-1 write route and the tier-2 poller run **in the AgentServer
process**, so all writes go through the one in-process `CartographerTree` instance
— exactly one writer per process. A `compare-and-skip on current HEAD sha` makes a
redundant or older-code write a no-op. (Cross-machine: each machine keeps its own
local index for read-locality, but only the lease holder AUTHORS — §Tier 2 — so
there is no cross-machine write contention on the canonical authored content.)

## Decision points resolved

1. **Tier-1 write route** — one deliberate write surface; full path validation +
   deterministic quality-bar parity with the sweep + lower precedence (re-authorable)
   + write-rate bound. **Resolved.**
2. **Author cost model** — leaves read bounded committed content; dirs read
   re-delimited child summaries (bottom-up, deepest-first); dir re-author gated on
   child-digest change. **Resolved.**
3. **Off-Claude routing** — a **runtime `router.for()` probe** each tick refuses to
   author when `framework === defaultFramework` (resolve-to-Claude) OR `available
   === false` (binary-missing), closing all three misroute paths before egress;
   `componentFrameworks.fallback: 'none'` is a documented deployment precondition
   that additionally hard-errors a mid-tick binary disappearance. Never a silent
   Claude run. **Resolved.**
4. **Pressure signal source** — shared `getHostPressure()` sampler (NEW
   behavior-preserving extraction — §Migration), re-sampled mid-tick; curtail with
   a floor. **Resolved.**
5. **Ratchet baseline storage** — hardcoded committed-script constant; output
   file never the floor; monotonic-by-construction; backlog growth also gated.
   **Resolved.**
6. **Multi-machine** — author path lease-gated; standby is detect-only.
   **Resolved (round 2).**
7. **`fresh` semantics** — fingerprint-current, not verified-correct; `confidence`
   + sampled re-validation. **Resolved (round 2).**

## Migration & Deployment / Agent Awareness

- **Merge order (hard):** spec #2 after spec #1 (PR #1041) lands on `main`; a
  defensive test asserts the `cartographer` `SHARED_DEFAULTS` key exists.
- **Config:** `freshnessSweep` is a **nested key UNDER the existing `cartographer`
  block** in `ConfigDefaults` `SHARED_DEFAULTS` — the deep-merge add-missing path
  backfills it to existing agents; no new `migrateConfig` block needed (verified:
  `applyDefaults` add-missing recursion backfills nested keys). Shape:
  `cartographer.freshnessSweep = { enabled: false, egressAcknowledged: false, cadenceMs: 600000, maxNodesPerPass: 25, maxCentsPerPass, framework: 'codex-cli'|'pi-cli'|'default', allowClaudeFallback: false, maxLeafBytes: 24576, minSummaryChars, maxSummaryChars, zeroProgressTicksToBreak: 3, breakerReescalateHours: 6, nodeFailQuarantineThreshold: 3, maxDeferredPasses: 5, revalidateSamplePerPass: 2 }`.
  **`cadenceMs` is pinned to 600000 (10 min) with idle-aware backoff** (full
  cadence while there is work; back off after K consecutive zero-candidate detect
  scans — the existing `IdleAwareCadence` building block) so a quiescent repo
  isn't a standing idle CPU floor. (Resolves open question 1.)
- **Component routing — registration + a guard test (round 2):** register
  `CartographerSweep` under category `job` in `src/core/componentCategories.ts`,
  AND add a wiring test asserting `categoryForComponent('CartographerSweep') ===
  'job'` so a missing registration fails CI rather than silently routing to Claude.
  (Registration is necessary but not sufficient — the §5 runtime probe is what
  actually guarantees off-Claude; this test guards path #1 of the three.)
- **`getHostPressure()` extraction is NEW work in this spec's scope (round 2),**
  not inherited: extract a shared sampler that both `SessionReaper` and the poller
  use. It MUST be **behavior-preserving for `SessionReaper`** (a test asserts the
  reaper's pressure-tier output is unchanged pre/post), and the spec documents that
  `monitoring.sessionReaper.cpu*LoadPerCore` dials **co-govern** the sweep's
  curtail/skip points (or the sweep takes its own thresholds if independent tuning
  is wanted). Carries an L6 seven-dimension side-effects review on the reaper.
- **CLAUDE.md (Agent Awareness) — BOTH paths (round 2, P3/P5):**
  `src/scaffold/templates.ts → generateClaudeMd()` (new agents) AND `migrateClaudeMd`
  (existing agents) both ship the tier-1 affordance, keyed on this spec's **own
  marker** (not a dependency on spec #1's marker shape), with a migration-idempotency
  test (run twice → single block). Drafted snippet:
  > **Keep the map true** — when you finish editing a subsystem, refresh its
  > cartographer node: `curl -X POST -H "Authorization: Bearer $AUTH"
  > http://localhost:4042/cartographer/node/refresh -H 'Content-Type:
  > application/json' -d '{"path":"src/foo/Bar.ts","summary":"…"}'`.
- **CI workflow:** add the `cartographer-freshness` `pull_request` job (above).
- **Rollback (round 2):** disabling `cartographer.freshnessSweep.enabled` stops the
  poller; cursor / local index / measurement files remain on disk and are **inert**
  (re-scan-on-load makes a stale cursor safe); the tier-1 route 503s; no migration
  reversal needed.
- **Multi-machine:** poller/cursor/index are per-machine for read-locality; the
  **author path is lease-gated**; the **CI ratchet on `main` is the canonical
  cross-machine floor.**
- **Bounded Notification Surface:** ALL sweep + ratchet output is log/JSONL-only
  or ONE aggregated summary — never one notification per node — with a burst test.
- **Dashboard:** no dashboard tab in spec #2 (fully observable via
  `/cartographer/health` + `/cartographer/stale`); a dashboard UX surface is within
  spec #5's scope, not owed by this spec.

## Test plan (3 tiers)

- **Tier 1 (unit):** the sweep engine over a fixture tree —
  - detect picks exactly `stale ∪ never-authored`;
  - **ordering**: a `stale`-parent + `stale`-child never authors the parent first;
  - **dir-amplification guard**: a comment-only deep edit refreshes the ancestor
    fingerprint with **no LLM call** (child-digest on the node unchanged);
  - bounded to `maxNodesPerPass` AND `maxCentsPerPass`, remainder reported;
  - **reentrancy**: a tick firing while one runs is skipped;
  - **idempotent cursor**: second tick re-does nothing; corrupt cursor → full
    re-scan, never exceeding per-tick caps;
  - **deterministic quality bar**: a one-char / symbol-less summary is rejected,
    node left `never-authored`, not counted by the ratchet; an inline write with no
    real symbol is 400'd (parity);
  - **routing probe (round 2)**: with `componentFrameworks` unconfigured (resolves
    to Claude) and `allowClaudeFallback:false`, assert **ZERO author calls reach
    the default provider** and the degradation is reported — tested against the
    REAL router's degrade path, not a bespoke always-correct stub;
  - **LlmAbortedError**: a preempted author does NOT count toward the breaker; node
    keeps prior status;
  - **sustained-failure + re-escalation**: permanently-rejecting model → breaks,
    surfaces once, re-escalates after the window;
  - **per-node quarantine**: a node failing K times is quarantined + surfaced;
  - **mid-tick CPU break**: pressure crossing critical mid-tick stops the loop;
  - **secrets egress**: a planted-credential file is never passed to an author call;
  - **multi-machine**: a standby (non-lease-holder) instance authors zero nodes;
  - **`fresh` ≠ correct**: a `fresh` node is sampled for re-validation per
    `revalidateSamplePerPass`.
  - The CI ratchet script: ratio over *authorable* nodes; new `never-authored`
    within grace does NOT fail; a synthetic `stale` regression DOES fail; a rising
    `neverAuthoredPastGrace`/`authorFailed` backlog DOES fail; the floor is the
    committed constant; a rename does not reset the grace clock.
- **Tier 2 (integration / HTTP):** `POST /cartographer/node/refresh` → 200 + node
  reads back fresh with `provenance.source: 'inline-agent'`; 503 disabled; **400 on
  a non-existent-node path, `..`, encoded-traversal (`%2e%2e`, `..%2f`), a
  leading-`/` path, an over-length summary, and a symbol-less summary**; 401 no
  bearer.
- **Tier 3 (E2E "alive"):** with the poller enabled (egress acknowledged) + a stub
  light-author on a non-default framework, a never-authored fixture node becomes
  authored+fresh after one tick; a code change makes it stale; the next tick
  re-authors it — observed through `/cartographer/health` (authoredCount rises,
  staleCount returns to 0, backlog counts present). Proves the poller is wired to a
  real `CartographerTree` + real git, not a no-op.

## Open questions

- **(Resolved in round 2)** ~~Cadence default~~ → pinned 10 min + idle-aware backoff.
- **(Resolved in round 2)** ~~Validator on the light tier vs stronger?~~ → the
  authority is the **deterministic symbol-presence check** (no LLM); any LLM
  affirmation is advisory and, if used, runs on a *different* tier than the author.
- **(Resolved — decided out of scope)** `egressScope` subtree confinement is NOT
  part of spec #2. Spec #2 ships the deny-glob + the egress-acknowledgement gate,
  which together fully satisfy the egress-consent requirement; no behavior here
  depends on subtree scoping. Operator-requested subtree-level egress scoping would
  be authored as its own separate spec if ever wanted — it is not owed work and
  nothing is left incomplete by its absence.
