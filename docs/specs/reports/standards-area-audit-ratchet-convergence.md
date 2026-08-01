# Convergence Report — Standards enforcement coverage is ratcheted per fundamental area

**Spec:** `docs/specs/standards-area-audit-ratchet.md`  
**Slug:** `standards-area-audit-ratchet`  
**Converged at:** 2026-08-01T07:29:17.000Z  
**Iterations:** 6  
**Final exact-body SHA-256:** `fd43abdbb9de1177c85f2802a99efbb6f0b1c50f05032d69f0bc77c0248cd0fb`  
**Final-round material findings:** 0

## ELI10 overview

The old standards check protected only one whole-registry percentage. That let a
large, well-covered family hide a regression in a small family. The converged
design reuses each existing Standards Registry `family` as a fundamental area,
gives every area its own exact non-lowering floor, and records which exact family
bytes received review evidence.

Changed content without current evidence blocks immediately. Old but unchanged
content does not become mysteriously wrong on a date boundary: a weekly workflow
resurfaces it through a summary, artifact, and one bot-owned issue after 90 days.
The Root is included at 1/1 and now names the real check that protects it.

The main tradeoff is deliberate strictness. Human-readable family names become
policy identities, full family bytes are hashed, and the first CI topology is
closed rather than accepting unproved equivalents. Rare renames and new workflow
topologies require reviewed migrations. The deterministic machinery proves
internal integrity after trusted review; it does not manufacture reviewer
authority or authenticate GitHub's control plane.

## Original vs converged

- **Originally:** only the aggregate ratio was protected.  
  **Converged:** all six parsed families have independent exact rational floors,
  current content digests, evidence references, and last-audited facts while the
  aggregate 0.70 floor remains additive.

- **Originally:** a timestamp risked becoming an age-expiry veto.  
  **Converged:** changed bytes and floor regressions block; elapsed age only drives
  a nonblocking weekly signal with loud delivery failure.

- **Originally:** committed JSON could have been a self-asserted symbol.  
  **Converged:** canonical jailed evidence binds every accepted family digest,
  stable reviewer/source claims, finding disposition, and convergence-report
  bytes. Every evidence entry is closed and unknown families are rejected.

- **Originally:** family lifecycle and protected-base comparison had reset paths.  
  **Converged:** removal, rename, backward time, floor reduction, weak admission,
  malformed prior rows, and unavailable required bases fail closed. A future
  versioned migration must carry prior policy history.

- **Originally:** Root merely cited files.  
  **Converged:** semantic YAML validation pins the exact supported event mapping,
  candidate full-history checkout, no-lifecycle dependency install, protected-base
  extraction, and unconditional failure-propagating check step. The spec also
  names code review/rulesets as the outer trust boundary.

- **Originally:** evidence paths and cadence issue ownership admitted edge-case
  confusion.  
  **Converged:** lexical and realpath jails reject separator and symlink escapes;
  issue mutation requires exact title, first-line marker, and bot authorship.

## Reviewer set

- `security-adversarial` — adversarial bypasses, path and workflow trust boundaries,
  evidence integrity, issue ownership, and failure propagation.
- `integration-scalability` — CI events, portability, runtime/source parity,
  bootstrap and lifecycle behavior, cadence, and operational closure.
- `decision-completeness-lessons` — frontloaded decisions, arbiters, rejected
  alternatives, migration/rollback, lessons, and item 5/6 fit.
- `codex-cli:gpt-5.5` — external cross-model review on the final exact body.
- Deterministic conformance service — 82 registry articles, zero findings,
  non-degraded parent-principle verdict `fit`.

## Iteration summary

| Iteration | Design findings | Precision findings | Principal changes |
|---|---:|---:|---|
| 1 — baseline adversarial review | 8 | 4 | Fail-closed registry, content-vs-age split, identity lifecycle, byte-bound evidence, null-prototype maps, exact time/ratio rules, newline parity, runtime parity, artifact reliability. |
| 2 — integration and cross-model review | 3 | 4 | Stable reviewer claims, convergence binding, manual-event base, lone-CR parsing, unconditional non-lowering language, new-area bootstrap closure. |
| 3 — operational closure | 0 | 5 | Migration minimum contract, review index clarity, bounded editorial workflow, issue lifecycle, worked area example. |
| 4 — Root/evidence hardening | 3 | 7 | Real CI self-wiring, semantic YAML parsing, exact pre-check prefix/base env, evidence realpath jail, malformed protected-base validation, issue authorship, exact aggregate/admission arithmetic. |
| 5 — exact-body round A (`fd43abdb…`) | 0 | 0 | No changes. External minor recommendations were adjudicated below; no unresolved material finding. |
| 6 — exact-body round B (`fd43abdb…`) | 0 | 0 | No changes. Three independent internal reviewers again returned explicit zero/zero verdicts. |

The 34 resolved finding families recorded in audit evidence are grouped below;
closely related bypass variants share one catalog item when they share one fix.

## Full findings catalog and disposition

### Registry, identity, and arithmetic

1. **Missing/empty/Root-less input could look assessed.** Resolved with full-checkout
   fail-closed behavior and explicit partial non-assessment.
2. **Aggregate coverage masked a weak family.** Resolved with a per-family map plus
   retained aggregate floor.
3. **Rename/removal could reset policy identity.** Resolved by exact base identity
   comparison and a required future versioned carry-forward migration.
4. **New-family bootstrap could set a zero baseline.** Resolved by explicit all-area
   admission at or above 0.70.
5. **Rounded comparisons admitted boundary gaps.** Resolved with BigInt rational
   cross-multiplication for area, aggregate, and admission decisions.
6. **Adversarial names collided with object prototypes.** Resolved with Map/null-
   prototype accounting and fixtures for `constructor` and `__proto__`.

### Audit evidence and content identity

7. **Git history/edit time could masquerade as audit.** Resolved with explicit
   canonical ledger/evidence artifacts.
8. **Evidence could self-assert reviewers without substantive binding.** Resolved
   with stable reviewer/source claims, finding disposition, and convergence-report
   byte binding; semantic authority remains review judgment.
9. **Evidence paths could escape lexically or through symlinked ancestors.** Resolved
   with normalized POSIX paths, backslash rejection, component lstat walks, and
   realpath containment for both evidence and reports.
10. **Extra evidence entries were not universally closed.** Resolved by validating
    every exact entry/hash/verdict and rejecting families outside registry/ledger
    closure in record and check modes.
11. **Line endings changed logical hashes.** Resolved by LF canonicalization of
    registry, ledger, evidence, and convergence report, including lone CR.
12. **A narrow article hash could miss contextual changes.** Resolved by versioned
    hashes of complete raw H2 family sections.
13. **Future/backward timestamps could corrupt ordering.** Resolved with canonical
    UTC validation, a documented five-minute skew tolerance, and monotonic time.

### Protected-base and Root self-wiring

14. **Candidate-only checks could lower floors directly.** Resolved by extracting
    and validating the protected-base schema-v2 ledger.
15. **Missing or malformed protected-base rows could silently skip comparison.**
    Resolved with closed keys, timestamps/bounds, hashes, paths, floors, and
    canonical serialization.
16. **Manual dispatch lacked a base.** Resolved with the supported `HEAD^` rule;
    PR and push rules use base SHA and `before` respectively.
17. **Root file references proved presence, not execution.** Resolved with a
    semantic workflow-wiring invariant in full-checkout mode.
18. **Regex workflow validation admitted comments, quoted keys, filters, conditions,
    failure swallowing, dependencies, and shell suffixes.** Resolved by parsing
    YAML and closing event/job/check-step mappings.
19. **Checkout redirection or pre-check environment poisoning could bypass candidate
    assessment.** Resolved with an exact five-step prefix, full-history checkout,
    `npm ci --ignore-scripts`, exact base resolver, and exact check environment.
20. **Protected-base wiring itself could be removed.** Resolved by including its
    resolver/output/env contract in Root self-wiring validation.
21. **Extra events could borrow the wrong base semantics.** Resolved by accepting
    exactly push-main, pull-request-main, and empty manual dispatch.
22. **Repository code cannot authenticate its executor or authorize itself.**
    Resolved as an authority clarification: candidate-tree validation is drift
    defense after trusted review; workflow rules/review are the outer boundary.

### Cadence and operations

23. **Age expiry would create permanent false-red builds.** Resolved by keeping age
    nonblocking and binding correctness to content freshness plus measured floors.
24. **Cadence could create issue spam or touch a same-title human issue.** Resolved
    with concurrency, pagination, one stable marker/title, first-line marker, and
    bot-author requirement.
25. **Issue API failures could silently erase the signal.** Resolved by propagating
    create/update/close errors as failed Actions runs while also writing a summary
    and uploading the report.
26. **Names could mention users or inject issue markdown.** Resolved with mention
    neutralization, markdown escaping, newline removal, and length bounds.
27. **Hidden report uploads could silently miss files.** Resolved with hidden-file
    inclusion and missing-artifact failure in both workflows.
28. **The weekly clean runner lacked the YAML dependency.** Resolved with the same
    no-lifecycle dependency installation used by standards CI.

### Parser/runtime/spec closure

29. **Source and packaged runtime used different area measurements.** Resolved by
    shared structural parsing and complete per-family parity assertions.
30. **Heading-like text in fences, quotes, or comments could split areas.** Resolved
    with visible structural H2 spans and planted boundary fixtures.
31. **The spec omitted migration, rollback, reviewer, and editorial contracts.**
    Resolved with bounded sections and a concrete Building 24/30 example.
32. **Root could remain an exemption.** Resolved by its real registry citation,
    measured 1/1 floor, and live-registry test.
33. **The general metric could overclaim effectiveness.** Resolved by naming it a
    reference-resolution proxy throughout the evidence contract; only Root adds
    the stronger repository-wiring invariant.
34. **A stale intermediate review artifact contradicted the final design.** Resolved
    by replacing it with this convergence report before evidence settlement.
## External recommendations adjudicated without design change

- **Add immutable family slugs now — rejected.** The operator explicitly requested
  reuse of parsed `family`; adding a second taxonomy creates mapping drift. The
  schema-versioned rename/tombstone contract preserves history when first needed.
- **Accept equivalent CI topologies now — deferred.** V1 intentionally accepts only
  topologies with proved base semantics. A future topology must add fixtures and
  a deterministic base rule before admission.
- **Treat same-PR evidence as external authority — rejected.** The spec prominently
  limits CI to internal integrity after trusted review.
- **Replace committed JSON with signed/native attestations — rejected for scope.**
  Those controls do not bind semantic adequacy to exact family bytes and add key,
  network, or platform authority. Repository rules remain complementary.
- **Rename the established Standards Enforcement Coverage report — rejected.** The
  precise field and evidence language say `refResolutionRatio`; compatibility is
  retained while the proxy limitation is explicit.

## Conformance and cross-model record

- External reviewer: `codex-cli:gpt-5.5`; final exact-body invocation succeeded.
- Final external verdict: minor recommendations, all explicitly adjudicated above;
  no unresolved design finding.
- Deterministic conformance: 82/82 articles assessed, zero findings, not degraded.
- Parent-principle fit: `Structure beats Willpower`, verdict `fit`.
- Registry canary: 82 article headings, complete, zero failures.
- Round B reused the Round A external result because spec and implementation bytes
  were unchanged; all three internal perspectives performed a fresh second read.

## Convergence verdict

Converged after two consecutive exact-body/tree rounds on
`fd43abdbb9de1177c85f2802a99efbb6f0b1c50f05032d69f0bc77c0248cd0fb`.
Both rounds produced DESIGN 0 and PRECISION 0 from security/adversarial,
integration/scalability, and decision-completeness/lessons reviewers. External
recommendations are resolved or deliberately rejected with rationale. No open
question remains. The spec is approved and ready for implementation settlement,
side-effects concurrence, full verification, and release.
