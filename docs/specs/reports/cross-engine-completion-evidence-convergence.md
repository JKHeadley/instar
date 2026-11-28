# Convergence Report — Instrumented Cross-Engine Local Completion Evidence

## Final artifact

- Spec: `docs/specs/cross-engine-completion-evidence.md`
- Final exact reviewable-body SHA-256:
  `d5c371a00f5b0f7b1d5639919bd08cc355a88eb60194aa36f5eb1c15280b1512`
- Final pre-tag file SHA-256:
  `82e6a056fb33307efb4130696aa72196ee4a4abac4b7ddb13d2399e3e3c90e79`
- ELI16: `docs/specs/cross-engine-completion-evidence.eli16.md` (2,248 words)
- Characterization: `docs/specs/reports/cross-engine-completion-characterization.md`
- Status: review-ready converged draft. It is not approved and does not authorize implementation,
  rollout, or a positive completion-verification surface.

The reviewable body was locked after two consecutive clean exact-body rounds. The convergence tag
is metadata outside that body and must not change the reviewable-body hash above.

## Reviewer disclosure

- Authoring session: Codex, GPT-5 family. The runner did not expose a more specific deployed model
  identifier.
- Internal CLASS review: three independent agents covered security/privacy,
  adversarial/failure-mode, scale, integration, decision completeness, and historical lessons.
- External exact-body review:
  - `codex-cli:gpt-5.5` completed and returned **SERIOUS ISSUES**;
  - `gemini-cli:gemini-3.1-pro-preview` degraded with `reason:error`, so it supplied no reliable
    final opinion.

Both external prompts reported truncation, and the Codex result said the referenced context was
omitted. The external pass is therefore useful dissent, not a complete independent proof.

External review is disclosed rather than converted into an approval claim. Codex's remaining
findings were architectural dissent, summarized and adjudicated below. Gemini's degraded result is
not counted as a clean review.

## What converged

The existing completion check reads Claude Code transcript state and intentionally no-ops other
engines. This design replaces that boundary with an Instar-owned, engine-neutral protocol for
instrumented deterministic local actions. The launcher owns candidate discovery, action identity,
close semantics, and rendering. Exact evidence produces clause-level `verified`, `contradicted`, or
`unknown`; an LLM never judges prose or another model.

The scope is deliberately narrow: named tests, named builds, causal local file writes, and
execution-only registered local commands. Remote delivery, provider durability, databases,
background effects, standalone CLIs, and proof of no hidden side effects remain unsupported and
cannot inherit a completion claim.

## Pathway characterization

The requested live characterization surfaces were tested on August 18, 2026:

- `GET /doorways` returned 503: the registry was unavailable;
- the decision-quality meter returned 503: the provenance seam was dark;
- the benchmark-divergence detector returned 503: the detector was dark.

No live route was promoted. The production design therefore stays deterministic. Historical
benchmark evidence supplies only these research seeds:

| Engine under review | Research primary | Research backup |
|---|---|---|
| Claude | pi / GPT-5.5 | Gemini API / Gemini 3.1 Flash-Lite |
| Codex | clean Claude one-shot / Sonnet 4.6 | Gemini API |
| Gemini | pi / GPT-5.5 | clean Claude / Sonnet 4.6 |
| pi | clean Claude / Sonnet 4.6 | Gemini API |
| Grok | pi / GPT-5.5 | clean Claude / Sonnet 4.6 |
| Instar-native | pi / GPT-5.5 | clean Claude / Sonnet 4.6 |

The Opus coding-harness route was disqualified. None of these seed routes has runtime authority;
they are inputs to a future benchmark rerun only.

## CLASS and convergence result

Two final rounds, S and T, reviewed the identical exact body at the hash above. Each round returned
zero material findings in all six perspectives:

| Perspective | Round S | Round T |
|---|---:|---:|
| Security/privacy | 0 | 0 |
| Adversarial/failure-mode | 0 | 0 |
| Scalability | 0 | 0 |
| Integration | 0 | 0 |
| Decision completeness | 0 | 0 |
| Historical lessons | 0 | 0 |

The iterative class review resolved these material issue families before the body was locked:

- launcher-owned complete candidates, closed unsupported/unknown/overflow sentinels, and a single
  digest-bound close that a model cannot edit or imitate;
- clause-level verification basis, exact predicate/target/causality rules, and absence/conflict
  mapping to unknown rather than contradiction or success;
- one canonical qualification tuple binding engine, build, platform, launcher, renderer, evidence
  components, schema, registry, and fixture runner;
- an independently signed dark qualification candidate followed by matching receipts, preventing a
  generation from choosing its own favorable denominator after measurement;
- provenance binding across candidate, generation, tuple, sources, terminal reduction, storage,
  calibration, and metrics without cross-tuple pooling;
- globally complete per-engine qualification plus exact local tuple admission, preventing one
  engine/build/host from borrowing another's proof;
- independently authorized membership and nonce-bound current-head freshness, separated positive
  health and emergency roles, signer-oracle defenses, and scrubbed private transport;
- bounded local and control-plane storage, explicit byte/cardinality/rate budgets, crash recovery,
  census limits, and N/N+1 capacity tests;
- machine-pinned in-flight turns, fail-closed inbound replay admission, and current Slack remaining
  entirely visibly unverified until unified acknowledged IDs exist;
- registry/AST generality ratchets, historical-backlog ownership, SelfHealGate limits, per-engine
  real fixtures, and full-cohort positive activation;
- operator-only diagnostic states that distinguish captured evidence held by control from evidence
  held by a local row without upgrading the user-visible result.

## External architectural dissent

The final Codex review still rated the spec **SERIOUS ISSUES** for five themes:

1. It preferred splitting the local evidence plane, global qualification plane, and control plane
   into separate specifications.
2. It preferred a more standard control substrate over the bounded custom publication workflow.
3. It questioned same-OS-user isolation for private evidence and producer state.
4. It objected that full canonical-engine parity can let the least-ready engine hold activation.
5. It found the terminology and overall size difficult to review.

These findings were not hidden or auto-cleared. They were adjudicated as deliberate, contested
architecture choices rather than newly discovered schema defects:

- one authority spec keeps the global positive-activation invariant reviewable end to end, while
  implementation is already divided into bounded packages and child workstreams;
- a routing-dependent per-engine positive surface was explicitly rejected because it recreates the
  original agent-general safety gap; dark-only operation is the closed fallback;
- the control protocol has fixed bounds, explicit custody, crash recovery, and named reopen
  triggers, with alternatives evaluated in the decision record;
- the spec already states that same-UID convenience is not a security boundary: keys and producer
  writes require an isolated supervisor/platform credential store and narrow inherited or brokered
  capabilities, otherwise that exact engine/build is ineligible; stored envelopes are scrubbed and
  make no same-user confidentiality claim for arbitrary engine-accessible local bytes;
- operator-only diagnostics explicitly distinguish captured-but-held control and row states.

An earlier concrete Codex finding about an ambiguous qualification denominator was accepted and
fixed with the exact canonical qualification tuple key and signed candidate/receipt handshake. The
remaining dissent is therefore preserved for the operator, not represented as consensus. It does
not grant approval.

## Standards-conformance and verification

The standards gate ran on the locked exact body:

- 88 standards checked;
- 0 findings;
- parent-spec fit: `fit`;
- registry canary: healthy, with 88 article headings and no failures;
- gate degradation: false.

After the convergence tag was applied, the normalized body hash remained unchanged. The ELI16
gate, strict self-heal lint, strict machine-local-justification lint, whitespace validation, and
the full project build all passed.

## Convergence verdict

The design completed 20 logical convergence iterations (A–T), culminating in the two clean
exact-body rounds S and T at the locked hash. It contains 22 frontloaded decisions, no cheap-tag decision, no
open user decision, and no contested finding falsely marked cleared.

Internal exact-body convergence is complete. External architectural dissent and the degraded Gemini
review remain explicitly visible. The artifact is ready for operator review, not approved.
