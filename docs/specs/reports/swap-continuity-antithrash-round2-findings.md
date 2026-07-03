# Swap-Continuity Anti-Thrash — Round 2 findings (consolidated)

Round 2 reviewers: 6 internal (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + Standards-Conformance Gate (RAN — live
server, 51 standards, **1 possible-violation flag**, folded as R2-M6) + external
passes per available family: **codex-cli/gpt-5.5 (RAN — verdict: MINOR ISSUES,
6 findings, none must-fix)** and **gemini-cli/gemini-2.5-pro (DEGRADED —
timeout at the 600 s bound; zero findings returned; recorded honestly as a
partial pass — round-1's gemini pass DID run, so the family is not blind
across the ceremony)**. Round-level cross-model flag: `codex-cli:gpt-5.5`
(clean — at least one non-Claude family succeeded this round). Note vs round 1:
the detector found codex-cli installed+authed this round (round 1 recorded it
not installed); the activation history now carries both frameworks.

Spec commit reviewed: a7f6e2cb0 (round-2 revision). Reviewable-body hash:
`2ba73495…`. Deduped across reviewers.

## Round-1 fold verification (all six lenses re-checked the claimed resolutions)

**43 of 44 round-1 findings verified GENUINELY RESOLVED in the revised text**
(not rebutted) — including every code-grounding claim (integration lens
verified all six named primitives exist: `hasActiveProcessesAsync`
SessionManager.ts:2907, `tmuxExecCoalesced` :623, `maybeRotateJsonlSegment`
jsonl-rotation.ts:128, `DEV_GATED_FEATURES` devGatedFeatures.ts:45,
`SubagentTracker.getActiveSubagents` :151, `currentInboundByTopic`
routes.ts:1256; all cited routes exist; no wrong-file/wrong-mechanism claims).
The frontmatter parent-principle is a REAL registry heading
(STANDARDS-REGISTRY.md:422) and "Structure beats Willpower" is the exact
registry name (:49). Both §14 cheap-to-change-after tags (Q1 dwell numeral, Q6
turn-boundary hook) were independently contested and **UPHELD**.

**The one exception: B2 is only MECHANICALLY folded** — the derivation
mechanism is written, but the window arithmetic reopens the §2.4 restart class
it was meant to close. Carried forward as R2-M2 below.

## MUST-FIX (MAJOR — material; each requires a spec change before build)

- **R2-M1 (security) — Sender attribution is unneutralized attacker-controlled
  input in a privileged prompt position (§4.3(3)).** The normative envelope
  neutralizes and clamps the quoted BODY, but the attribution ("from <sender>
  at <time>") is drawn from `SenderEnvelope` fields
  (`fromUsername`/`fromFirstName`, routes.ts:17187-17188 — fully
  sender-controlled, ~64 chars) and rendered in the FRAMING position, outside
  the quoted-data region. A hostile display name (`»\n\nSYSTEM: …`) lands
  imperative text in the respawned agent's prompt; a spec-compliant build is
  still injectable. FIX: extend §4.3(3) to delimiter-neutralize AND
  length-clamp the attribution fields, rendered as quoted data (same trust
  class as the body), never as framing.
- **R2-M2 (adversarial + scalability, deduped) — Breaker/dwell restart
  re-derivation window arithmetic reopens B2 (§3.5, §6.1, §7).** Three holes
  compound: (1) boot hydration is bounded to `max(dwellMs 45m,
  reversalWindowMs 30m)` but `thrashBreakerBackoffMs` is 60m — a restart in
  the [T+30m, T+60m] tail of an episode re-derives thrash=0 and boots the
  breaker CLOSED, resuming proactive swaps up to 30 min early on exactly the
  restart-heavy days §2.4 defends against; (2) "the newest rotated segment"
  (singular) silently under-covers the window if a 10 MB segment ever rotates
  inside it (unstated write-rate assumption; I3/I8 violations on under-primed
  boot); (3) the §6.1 schema carries `episodeId` but no
  `breakerOpenedAt`/deadline and no episode-open row — "boots OPEN with the
  original deadline" has no in-schema source, and derivation keys on the
  minority reversal rows while ignoring the majority episodeId-stamped
  suppressed rows. FIX: hydration bound = `max(dwellMs, reversalWindowMs,
  thrashBreakerBackoffMs)`; walk retained segments newest-first until the
  oldest row read is older than the bound (bounded by keepSegments=2; flag a
  degraded/under-primed boot honestly if retention cannot cover the window);
  add `breakerOpenedAt`/`breakerDeadline` (or a durable episode-open row) to
  §6.1; re-derive an open episode from the most-recent un-expired
  episodeId-stamped row of ANY decision kind.
- **R2-M3 (adversarial) — An N≥3 directed rotation (A→B→C→A) defeats both
  reversal detectors; the "structurally impossible — the breaker PROVES it"
  claim is false beyond 2-cycles (§3.5).** Same-session refusal and pair-level
  detection both key on pair INVERSION; a consistent-direction rotation never
  produces a reverse edge, never increments the thrash counter, never opens
  the breaker. Dwell only PACES it (~32 swaps/day/session at the 45-min floor
  — incident-scale volume with every brake reporting green). Bounded harm (the
  work gate still protects busy sessions; each hop must pass
  materially-better), but Piece 1's stated goal is unmet for N≥3 and the
  breaker's "proof" claim overclaims. FIX: add a direction-agnostic
  per-session swap-frequency detector (≥K proactive executions within window W
  feeds the thrash counter, detection-only — refusal semantics unchanged), and
  scope §3.5's impossibility claim honestly to 2-cycles.
- **R2-M4 (decision-completeness + adversarial, deduped) — The model-swap
  `subagentIdleLeg` default is self-contradictory, and §0(d) overclaims
  model-swap protection while the leg can be dark (§0, §4.2, §7, §14-Q5).**
  "Default follows the model-swap feature's rollout stage" resolves to ON for
  an already-live feature — the exact "silently change a live refusal surface"
  outcome the same paragraph forbids; meanwhile §0 asserts model-swap "can
  never kill in-flight work" while the pane-only idle check (no subagent leg,
  ModelSwapService.ts:119) remains the live behavior until the flag flips. A
  builder must choose between the stated policy and the stated safety rule —
  a genuine mid-build stop-and-ask on a user-visible surface (never cheap).
  FIX: concrete default `subagentIdleLeg: false` (dark) everywhere, graduating
  on its OWN explicit rollout rung; scope §0(d) honestly ("model-swap's
  subagent protection arrives with the `subagentIdleLeg` flip") or couple the
  leg's default-on to swapContinuity going live.
- **R2-M5 (adversarial) — The re-intent backoff is keyed on the target pair
  and is evaded by target rotation (§4.2).** After a `deferral-ceiling-dropped`
  on A→B, the next tick selects A→C (not backed off) and the never-idle
  session cycles defer→drop across pairs forever — the stated "must not cycle
  forever" invariant is not delivered whenever ≥2 cool targets exist; the
  30-min ceiling clock also resets on every best-target change. FIX: key the
  re-intent backoff AND the deferral-age/ceiling clock on `(session)` (or
  `(session, source-account)`), carrying accumulated deferral age across
  target re-selection within one intent episode.
- **R2-M6 (lessons-aware + Standards-Conformance Gate, deduped) — The accepted
  reactive cascade lacks the P19 escalate-once brake, and its foundation
  terminal state is SILENT (§3.1/Q2; foundation server.ts:15974).** The spec's
  parent principle mandates backoff + a breaker that surfaces degradation once
  + a cap (or an explicit Eternal-Sentinel declaration, which still mandates
  escalate-once). The cascade treatment supplies only the cap (the 5-per-10-min
  counter — verified real and stable-keyed) and substitutes passive ledger
  visibility for escalation. One layer below, the reactive path's failure is
  genuinely silent today: `refreshFn→false` is discarded (`void`,
  server.ts:15974), a respawner throw is an unhandled rejection, and
  `onNoAlternate` covers only the no-alternate case — a session can strand on
  a walled account with no signal (the P18 corollary the spec's own
  frontmatter cites). I6-SAFE FIX (nothing new refused): a detection-only,
  episodeId-deduped, escalate-once attention item when a reactive hop-chain
  crosses a sustained threshold within `reversalWindowMs` OR when the rate cap
  refuses a reactive swap; declare the reactive continuity loop as the
  sanctioned Eternal-Sentinel exemption under P19; name the foundation
  silent-discard as a fix-alongside.

## SHOULD-FIX (MINOR)

- **R2-m1 (security) — §6.1 "no route serves raw rows" is overstated:** the
  default-on Files viewer (`allowedPaths: ['./']`, fileRoutes.ts:19-29) serves
  `state/swap-ledger.jsonl` verbatim to a Bearer/PIN holder. Same holder can
  already read every state ledger, so no escalation — but soften the wording
  ("no dedicated ledger route") or add the ledger to the viewer deny-list.
- **R2-m2 (scalability) — `thrash-breaker` suppression rows bypass the L3
  state-transition treatment:** breaker evaluates before all-hot, so a breaker
  hour writes per-candidate-per-tick rows (~N×20/h) — the exact sustained
  write pattern L3 killed, relocated. Give breaker suppression the same
  enter/leave/heartbeat rows keyed on `episodeId`.
- **R2-m3 (scalability + integration, deduped) — the "one shared ps per sweep"
  mandate is not deliverable through the cited primitive:**
  `hasActiveProcessesAsync` is PRIVATE, forks its OWN full `ps -eo` per call
  (SessionManager.ts:2924), and folds indeterminate→true (:2919) — the
  opposite of the tri-state §4.1 promises for the child-process leg.
  `tmuxExecCoalesced` is also private. FIX: name the new PUBLIC batched probe
  (`SessionManager.checkSessionWorkStateAsync`: single `ps` snapshot →
  per-session `computeHasActiveProcesses`), require the child-process leg to
  surface its own `indeterminate`, and pin "exactly one ps fork per sweep" in
  the wiring test.
- **R2-m4 (scalability) — concurrent reactive grace loops each fork an
  uncoalesced `ps` every 10 s during an all-hot cascade** (the shared-snapshot
  language is sweep-scoped). Back the child-process leg with a short-TTL
  (~1–2 s) shared ps snapshot cache at the SessionManager level.
- **R2-m5 (adversarial) — `callerClass` provenance is not pinned:** nothing
  forbids a future route from populating it from request input; a wire-derived
  `recovery` would bypass the gate AND the mitigations. Add the invariant
  ("`callerClass` is set only by server-internal call sites, never from
  request input") + a wiring test.
- **R2-m6 (adversarial) — the execution-failure streak/backoff (§3.6) is
  in-memory only:** a crash-loop day resets the backoff and re-alerts once per
  boot, breaking one-item-per-streak. Re-derive streak + dedupe key from
  ledger `failed` rows at boot (rides the R2-M2 hydration fix).
- **R2-m7 (decision-completeness) — recovery-class callers are never
  enumerated**, and the safe default (refusal) is unsafe for exactly that
  class (a wedged "working" pane would deadlock recovery if a recovery caller
  ships untagged). Enumerate the known recovery respawn call sites
  (ContextWedge, stuck-signature, watchdog) as `recovery`-tagged in the spec.
- **R2-m8 (lessons-aware) — the per-swap "Session respawned." topic notice is
  unbounded across a cascade** (respawnSessionForTopic, server.ts:1292-1294 —
  not `silent:true`): the continuity mechanism becomes topic spam, against the
  spec's own constitution line. Silence or per-episode-dedupe swap respawn
  notices.
- **R2-m9 (lessons-aware) — `lessons-engaged` omits P20 (Verify the State,
  Not Its Symbol)** — the gate implements P20's discipline (§4.1/I7) on the
  exact pane surface P20 crystallized from; add the citation.
- **R2-m10 (codex external) — `force` lets any bearer token bypass the work
  gate.** No regression vs today (today EVERY refresh kills unconditionally;
  force restores the status quo, the gate strictly adds protection) — but the
  spec should state that rationale explicitly, and name a distinct
  capability/scope for force as a possible hardening follow-up.
- **R2-m11 (codex external) — ledger durability rules unstated for its
  state-source duty:** specify atomic single-line appends and
  corrupt-trailing-line tolerance on hydration (treated as absent + counted),
  so partial writes can't poison the restart derivation (rides R2-M2's
  rewrite).
- **R2-m12 (codex external) — target filter ignores projected post-swap
  utilization:** the 15-point headroom IS the burn/lag proxy (§3.3 says so
  implicitly); state it explicitly, and note per-session burn estimation as a
  possible refinement — the per-target-per-tick cap bounds the immediate
  pile-on.
- **R2-m13 (codex external) — fleet-rollout caveat for multi-machine
  shared-account installs:** machine-local brakes can co-select the same cool
  account from stale local views (the §8 contention follow-up at fleet scale).
  Add to §10 rung 4: multi-machine installs sharing accounts get the brake
  (still a strict improvement — today they have NO brakes), with the
  contention follow-up named as the full fix; no rollout gate required.

## LOW

- **R2-L1 (security)** — transcript-path index in `killedSubagentList` outlives
  the event; note it as local-only debugging aid excluded from export/feedback
  bundles.
- **R2-L2 (security)** — "sanitized error class" (§3.6) undefined; pin to
  constructor-name/fixed-enum only — never `.message`/`.stack`.
- **R2-L3 (adversarial)** — the re-intent backoff itself is in-memory and lost
  on restart (defer-only blast radius); either persist a last-drop marker or
  state best-effort-across-restarts explicitly.
- **R2-L4 (decision-completeness)** — all-hot heartbeat interval (30 min) is
  specified but hardcoded while every sibling cadence is a config knob;
  inconsistency only.
- **R2-L5 (decision-completeness)** — `authLevel` missing from §6.2's
  single-sourced enums; the `reason` member for `proceeded` rows unnamed
  (plausibly the pre-proceed `busy-*` value — say which).
- **R2-L6 (integration)** — `session_busy` (wire, §4.5) vs `session-busy`
  (ledger enum, §6.2) spelling split; pick one.
- **R2-L7 (integration)** — dashboard rendering of the thrash counter is not
  scoped; add one line ("API-only in v1; dashboard tile is a follow-up").
- **R2-L8 (integration)** — pin the migration default-direction with a §12
  assertion: absent `antiThrash` on a `proactiveSwap.enabled:true` install
  resolves `enabled:true, dryRun:true` (a `false` mis-resolution would skip
  the soak fleet-wide).
- **R2-L9 (lessons-aware)** — no P7 supervision-tier declaration; add the
  explicit "Tier 0 — deterministic quota/state math, no LLM policy decision"
  line.
- **R2-L10 (codex external)** — glossary/density: internal idiom (wall, dark,
  dev-gate, F3, P19) raises outside-reader load; the eli16 companion carries
  this burden — optionally add a one-line glossary pointer in the spec header.
- **R2-L11 (integration)** — residual 1-line drift: reactive swap wiring
  closure actually at server.ts:16022-16025.

## Detector-probe results that came back CLEAN (adversarial)

Breaker-opens-mid-grace (reactive ignores breaker, no cross-contamination);
re-intent-backoff+dwell starving a legitimate swap (impossible — both ≤45 min,
reactive floor beneath); reactive-grace vs deferred-fire race (serialized by
the in-flight refresh guard + I9 invalidation); force as rate/mitigation
bypass (it is neither).

## External pass status

- **codex-cli (gpt-5.5): RAN** — verdict MINOR ISSUES, 6 findings, none
  must-fix; all folded above (R2-m10..m13, R2-L10; its work-detection-heuristics
  point folds into R2-m3's tri-state fix).
- **gemini-cli (gemini-2.5-pro): DEGRADED — timeout at the 600 s bound,** zero
  findings returned. Partial pass recorded honestly; does NOT collapse to
  unavailable. (Round 1's gemini pass ran successfully, so the Gemini family
  has reviewed this spec lineage.)

## Standards-Conformance Gate

RAN (live server, 51 standards): **1 possible-violation** — "No Unbounded
Loops" vs the accepted reactive cascade (no escalate-once brake). The
lessons-aware reviewer's verdict on the flag: **NEEDS-CHANGE**, with the
I6-safe minimal fix folded into R2-M6. Parent-principle fit check: `fit`,
parentResolved: true.

## Convergence verdict

**NOT CONVERGED.** Round 2 surfaced **6 deduped MAJOR findings** (R2-M1..M6)
— zero criticals, but material spec changes are required before build. The
design's shape survived review intact (all four operator-demanded §0
properties held; no reviewer proposed weakening any of them — every MAJOR fix
is additive or corrective within the existing structure, and R2-M6's fix is
explicitly I6-safe). 43/44 round-1 findings verified genuinely folded; B2's
fold is completed by R2-M2. Round 3 required: fold R2-M1..M6 (+ the cheap
minors) into a round-3 revision, then re-run the full round (externals
mandatory — the reviewable body will change).
