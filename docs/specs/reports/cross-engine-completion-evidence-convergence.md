# Convergence Report — Instrumented Cross-Engine Local Completion Evidence

## Final artifact

- Spec: `docs/specs/cross-engine-completion-evidence.md`
- Final reviewed SHA-256:
  `e59c70bfb711a5ed19d963092462d111e3054997dab38e1e15aa1453e67841fd`
- ELI16: `docs/specs/cross-engine-completion-evidence.eli16.md` (1,405 words)
- Characterization:
  `docs/specs/reports/cross-engine-completion-characterization.md`
- Status: converged draft; not approved; implementation is not authorized by this report.

## Reviewer disclosure

- Authoring session: Codex, GPT-5 family. The exact deployed author model identifier was not
  surfaced by the session runner.
- Internal review: three independent internal agents covered all six required perspectives:
  security/privacy, adversarial/failure-mode, scalability, integration, decision completeness, and
  historical lessons. They inherited the authoring model family; exact deployment identifiers were
  not surfaced.
- External final exact-body review:
  - `codex-cli:gpt-5.5` — MINOR ISSUES, zero material findings;
  - `gemini-cli:gemini-3.1-pro-preview` — MINOR ISSUES, zero material findings.
- External prompts were not truncated.

## ELI10 overview

The old check looked at Claude Code's transcript and did nothing for other engines. The converged
design moves the reliable boundary into Instar's owned launcher. It works for Claude, Codex,
Gemini, pi, and Instar-native jobs when they run through that boundary.

The launcher records every mediated local action before it runs, keeps unsupported and unknown
actions visible, and renders the evidence block itself. The model cannot choose which actions
count. Exact local evidence yields verified, contradicted, or unknown. No model judges another
model's prose.

The scope is intentionally local: tests, builds, causal file changes, and execution-only registered
commands. Pushes, messages, providers, hidden side effects, and standalone CLI sessions remain
unsupported/unknown and require separate specs.

## CLASS review result

### Missing standard fixed

An agent-general mechanism now requires an explicit characterized row for every build-supported
engine. Each admitted engine/action row names the instrumented primary, deterministic
fault-separated verifier/native redundancy, real fixture, trust basis, and failure tests.
Unsupported or uncharacterized work is explicit and cannot silently no-op.

### Development-process gap fixed

The previous process treated a declared Claude-only no-op as complete. The converged design adds:

- a coverage-preserving registry and exhaustive registry+observed manifest;
- CI rows/corpus for every build-supported engine;
- real per-engine fixtures;
- fault injection for producer/store separation;
- per-engine stream/output ownership;
- rollout and capacity gates whose denominators cannot omit unfavorable rows.

## Characterization result

The requested pathway benchmark was executed before selecting the runtime design:

- Live `GET /doorways`, `GET /decision-quality`, and `GET /benchmark-divergence` returned explicit
  503/degraded states on this agent.
- Direct probes found Claude Code/headless, Codex, and pi runnable; the Gemini shim lacked a
  selected asdf version.
- The closest `completion-judge` benchmark produced useful research candidates, but it uses
  transcript-shaped inputs. The durable production mirror contains `tone-gate`, not the canonical
  completion-evidence task.

Conclusion: no door/model route has runtime authority. V1 is deterministic; measured model routes
remain research-only.

## Iteration summary

| Iteration | Material issue class | Resolution |
|---|---|---|
| 1 | Claude-only no-op; missing engine matrix | Added CLASS standard/process correction and engine/action coverage model |
| 2 | Model benchmark could be mistaken for authority | Separated characterization research from deterministic runtime admission |
| 3 | Transcript/native assumptions and weak correlation | Made Instar instrumentation primary; added signed turn/action identities and exact target matching |
| 4 | Missing consequence/causality contracts | Defined action-specific local report/state contracts; absence never contradiction |
| 5 | Model-controlled claim completeness and spoofable prose | Made candidates/renderer launcher-owned; isolated and escaped unverified commentary |
| 6 | Umbrella scope had receipts/workflows/confinement mixed into v1 | Removed durable-external, async, workflow/outbox, and broad-confinement designs; narrowed to deterministic local actions |
| 7 | Unsupported/unknown work could disappear before schema lookup | Added closed sentinels, pre-invocation candidate registration, overflow behavior, and exhaustive manifest |
| 8 | Row/retention/byte quotas were arithmetically inconsistent | Changed to bounded per-turn heads, explicit CBOR and component budgets, 31-bucket soak, and sustainable daily rate |
| 9 | Per-turn head could not represent action lifecycle/source multiplicity | Added immutable per-action staging/source tables, atomic terminal reduction, per-action conflict isolation, crash/TTL behavior |
| 10 | Final state/schema/integration closure | Added sentinel canonical encodings, optional pool projection with local fallback, pool-stable persisted mapping, trust-basis/UI scope, and exact CI fixtures |

## Material findings catalog

All material findings were resolved in the final body:

- **Authority/completeness:** model cannot add, omit, resolve, or scope away mediated candidates;
  unknown/unsupported/overflow sentinels exist before schema lookup.
- **Scope:** only Instar-launched deterministic local actions; no global task-completion, sandbox,
  provider, or standalone-session claim.
- **Verdict correctness:** exact schema/target/causality rules; explicit matching failure alone can
  contradict; missing/different/stale/conflicted evidence is unknown.
- **Trust disclosure:** local supervisor, independent local producer, and authoritative local state
  remain distinct bases; none claims host independence.
- **Presentation:** fixed scoped copy, no global done badge, escaped structurally separate
  commentary, and proof-gated evidence block.
- **Correlation/replay:** signed host and pool-stable opaque turn/action mappings independent of
  timestamps/text; local verification survives pool-key unavailability without projection.
- **Storage:** bounded per-action intent/result/source staging; atomic close reduction; at most two
  terminal revisions; per-action conflict isolation; bounded crash/orphan cleanup.
- **Capacity:** 15 executable actions plus sentinel, 64 concurrent turns, 200 new terminal heads/day,
  31 retained UTC buckets, 8 KiB CBOR envelopes, dedicated SQLite component budgets, and measured
  maximum-rate/size/WAL/index soak.
- **Privacy:** raw prompts, arguments, results, paths, names, prose, secrets, and provider IDs are
  excluded; cross-machine reads use scrubbed closed projections only.
- **Operational discipline:** real seven-day measurements, closed success/failure denominators,
  rollout freeze/de-admission for sustained threshold breach, restore cold-start reason, and
  independent kill switches.
- **Architecture:** existing recorder + bounded revisions selected for one local reducer; explicit
  alternatives and reopen triggers for a second reducer, historical recomputation, async
  settlement/retries, provider dispatch, or exported build attestations.

## Final review result

All six internal perspectives returned CLEAN on the final exact body:

- security/privacy: zero material findings;
- adversarial/failure-mode: zero material findings;
- scalability: zero material findings;
- integration: zero material findings;
- decision completeness: zero material findings;
- historical lessons: zero material findings.

Both external model families returned MINOR ISSUES and zero material findings. Their remaining
comments concern terminology/accessibility, durable-intent failure wording, out-of-band UI
channels, key-lifecycle consolidation, and future interoperability/deferred-scope presentation.
They do not change the reviewed safety, architecture, deployment, or decision boundary.

## Standards-Conformance Gate

The gate was invoked against the final exact body. It returned HTTP 503:

```text
constitution unreadable: ENOENT ... /Users/justin/Documents/Projects/instar-codey/docs/STANDARDS-REGISTRY.md
```

This is recorded as an unavailable gate, not a pass and not a skipped check. The running server's
configured project directory does not contain the registry file.

## Convergence verdict

Converged at iteration 10 with 14 frontloaded decisions and no open user decision. No unresolved
material security, architecture, integration, scale, decision, or deployment finding remains.

The spec is ready for operator review. It is not approved, and this report authorizes no
implementation or rollout.
