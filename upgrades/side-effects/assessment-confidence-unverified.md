# Side-Effects Review — assessmentConfidence: my own honesty field was overclaiming

## Summary of the change

`CoverageSummary.assessmentTrustworthy` (shipped hours earlier in PR #1641) reported **`true` over
the exact defect it was added to expose.** Verified on the LIVE endpoint after v1.3.975 deployed:

```
total: 22 | enforcedRatio: 0.0455 | assessmentTrustworthy: TRUE | canaryOk: true | canaryFailures: 0
registry.parsed: 22 | articleHeadings: 22 | bytes: 46606 | families: [5 of the 6]
```

The source registry carries **81** articles. The stale agent-home copy is not malformed — it is a
self-consistent document that is a quarter of the real one, so it passes every INTERNAL check by
construction (all headings parse, none dropped, anchors present, count above the floor).

`assessmentTrustworthy` was computed as `total > 0 && registry.canaryOk` — i.e. "my internal checks
passed". It READ as "this assessment is trustworthy". Conflating those is the failure the whole
instrument was being fixed for.

Replaced by a tri-state `assessmentConfidence` (`'verified' | 'unverified' | 'untrustworthy'`) plus
an always-populated `confidenceReason`. The boolean is retained, deprecated, TRUE only on
`'verified'`.

**Root insight:** nothing INSIDE a 22-rule document says it should have 81. Trustworthiness is not
obtainable by looking harder at the file — it needs an EXTERNAL expectation. That mechanism is the
blocked `standards-registry-snapshot-refresh` spec, so `'verified'` is unreachable today, and the
honest verdict for every passing read is `'unverified'`.

Proven against the real live registry (all four states):

| input | before | after |
|---|---|---|
| the live 22-of-81 copy | `trustworthy: true` | `unverified` + reason |
| the real 81-article registry | `true` | `unverified` — still correct; nothing to check against |
| a MATCHING expectation | unreachable | `verified` |
| a MISMATCHED expectation | unreachable | `untrustworthy` |

## Decision-point inventory

- `computeCoverage` / `GET /conformance/coverage{,/health}` — OBSERVE-ONLY. Gates nothing, blocks
  nothing, no code path branches on the verdict. This changes what is REPORTED, never what anything
  DOES.
- `deriveAssessmentConfidence` — new, exported, pure. Extracted deliberately: inline, TypeScript's
  flow analysis proved `'verified'` unreachable and REJECTED the comparison deriving the deprecated
  boolean. That rejection is TRUE and is the point; a function keeps the union open for when an
  expectation ships without pretending it is reachable now. (TS caught this, which is worth noting —
  the compiler objected to a claim I could not yet honour.)
- No gate, hook, sentinel, reaper, scheduler, migration or config surface touched.

## 1. Over-block

Nothing blocks. The adjacent risk is over-alarming: `assessmentTrustworthy` is now `false`
EVERYWHERE, including for a complete and correct registry. That is intentional and argued in the
ELI16: the instrument genuinely cannot verify completeness today, so anything stronger is the same
overclaim in nicer clothes.

The tri-state exists precisely so this is not alarming: `'unverified'` says *I do not know*, which is
neither reassuring nor a red flag. A consumer reading only the deprecated boolean sees `false` and
may over-read it — which is why the boolean is deprecated in its doc comment and the reason string is
always populated.

## 2. Under-block

No detection is weakened: `'untrustworthy'` still fires on every case the boolean fired on (nothing
parsed, canary objected), asserted in the updated tests. The change only ADDS a state between "fine"
and "broken" where none existed.

The residual gap, stated plainly: **a coherent stale registry is still reported with real-looking
figures** (`total: 22, enforcedRatio: 0.0455`). It is now labelled `unverified` with a reason naming
the possibility of "a coherent older copy", but the instrument cannot say *which* is the case. Only
the blocked spec closes that. This change makes the uncertainty visible; it does not resolve it, and
it must not be described as resolving it.

## 3. Blast radius

One field's semantics in `src/core/StandardsEnforcementAuditor.ts`; the route spreads the summary so
the new fields flow automatically. Consumers checked with a full-text scan (`grep` silently returned
nothing for a pattern present twice in this very file — python was used instead, and that tooling
anomaly is recorded):

- `assessmentTrustworthy` appears in exactly three test files (all updated) and nowhere in `src/`
  outside its declaration and derivation. No runtime branch reads it.
- The response is additive apart from the boolean's meaning narrowing; no field renamed or removed.

## 4. Rollback plan

Single-commit revert; no state, config, migration or persisted artifact. The audit recomputes per
request.

## 5. Test coverage (all three tiers)

- **Unit** (`standards-enforcement-auditor.test.ts`, 16 pass): a coherent-but-stale registry (a real
  whole-family subset of the live constitution) has zero dropped headings and `parsed ===
  articleHeadings` — i.e. passes every internal check — and STILL must not read `verified`; plus
  `deriveAssessmentConfidence`'s four verdicts in both directions, including that a mismatched
  expectation is `untrustworthy` rather than merely `unverified`.
- **Integration** (`conformance-dev-gate-route.test.ts`): the HTTP body carries
  `assessmentConfidence: 'untrustworthy'` for an empty registry.
- **E2E** (`standards-coverage-lifecycle.test.ts`): the verdict and its reason survive the production
  initialization path.

## 6. A fourth test found encoding the defect

`standards-enforcement-auditor.test.ts` asserted `assessmentTrustworthy === true` for the full
registry — pinning the overclaim as a specification. That is the FOURTH test found this evening
asserting the behaviour it should have been challenging (the others: the standards parser's
five-family allowlist, a fixture whose meaning changed with the wall clock, and the
learning-velocity route's filed-items-count-as-learning fixtures).

Four in one day is not a coincidence about those four tests. It is a property of how tests get
written here: they pin what the code currently does. A green suite therefore attests to
self-consistency, not correctness — which is the same shape as everything else this project has
found, applied to our own verification. Recorded as a class; not fixed here, because the fix is a
standard about how assertions are chosen, not a code change.

## 7. How this was found, which is the transferable part

Not by a test. By deploying and reading the live surface. The suite was fully green — it tested the
cases I had thought of, which were exactly the cases my fix handled. The stale-but-coherent case was
outside my imagination, and no amount of internal testing would have surfaced it.

Two hours from shipping to discovery. The generalisable rule: **after shipping an honesty fix, read
the live surface for the case you were fixing.** If the number you set out to correct still looks
fine, you have not corrected it.
