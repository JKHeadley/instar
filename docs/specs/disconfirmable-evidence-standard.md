---
title: "Corroboration requires an instrument that could have disagreed"
slug: "disconfirmable-evidence-standard"
author: "Echo"
eli16-overview: "docs/specs/disconfirmable-evidence-standard.eli16.md"
origin: "EVO-024 (proposed 2026-08-30 from LRN-030, LRN-031, LRN-032, LRN-033)"
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol - a constant result is not a second source, even when it agrees with a real measurement."
  - "EVO-009 consumer evidence - claims about downstream behavior must inspect the consumer, not only the artifact producer."
  - "EVO-023 denominator visibility - a numerator without the population it was measured over can read as a value when it is only absence of measurement."
  - "LRN-031 undefined-route evidence - an HTTP result only counts after the instrument is proven to distinguish a known-present case from a known-absent case."
review-convergence: "pending"
approved: false
status: "draft - awaiting /spec-converge, then operator approval"
---

# Disconfirmable Evidence Standard

## 1. Claim

An evidence line only corroborates a claim when the instrument used to produce it could have
returned a result that would refute that claim.

If every relevant input produces the same observation, the observation is a constant. It may be a
useful hypothesis source, but it is not corroboration and must not be presented as a second signal.

This spec turns that rule into structure across the evolution loop:

1. learnings and proposals record what result would have disproved each consequential evidence line,
2. HTTP evidence probes prove the route can distinguish a known-present case from a known-absent one,
3. ratio and verdict surfaces display their denominator and render zero-denominator states as
   `unmeasured`, and
4. audits that claim behavioral validity inspect the consumer that reads an artifact, not only the
   producer that wrote it.

## 2. The repeated failure class

EVO-024 was raised because four new learnings and five existing proposals shared one shape:
producer-side or constant evidence agreed with a claim and was read as independent confirmation,
even though some readings could never have disagreed.

The concrete instances:

| source | constant or non-disconfirming instrument | why it did not corroborate |
|---|---|---|
| LRN-031 | `GET /evolution/actions/:id` returned 404 for `ACT-299` | the route does not exist, so every id returns Express's default 404 |
| LRN-033 | `fired=0` over `0` classified verdicts | zero over zero means nobody measured it, not that the component never fires |
| LRN-030 | two terminal action records survived in the queue | the same file shape fits aggressive eviction and an inert prune at saturation |
| LRN-032 | context files were non-empty | non-empty producer artifacts do not prove boot-time consumers read them |
| EVO-011 | `expires_at` is null on all entities | the expiry filter has never had a populated value to exclude |
| EVO-007 / EVO-015 | entry size was measured on pinned entries | the sample was selected on the axis being measured |
| EVO-014 | commit proof used a check blind to stash-shaped commits | an empty result could mean absent work or reachable work outside that instrument's shape |
| EVO-005 | a fixed cap of 200 was treated as a stable population | the cap silently converted a 3.5-day store into a 14-hour visible window |

The class defect is not "bad evidence exists". It is that the record has no field forcing the
author to state the refuting outcome and denominator before promoting the line from hypothesis to
evidence.

## 3. Data model

Add a structured evidence shape for evolution proposals and learnings. Existing free-text
descriptions remain for compatibility, but any new consequence-bearing evidence must also carry
machine-readable fields.

```ts
export interface EvolutionEvidenceLine {
  claim: string;
  instrument: {
    kind: 'http' | 'consumer' | 'query' | 'file' | 'process' | 'manual' | 'other';
    target: string;
  };
  observed: string;
  denominator?: {
    label: string;
    value: number;
  };
  disconfirmation: {
    resultThatWouldRefute: string;
    probePerformed: boolean;
    probeObserved?: string;
  };
  evidenceClass: 'evidence' | 'hypothesis' | 'unmeasured';
}
```

Rules:

- `evidenceClass: 'evidence'` requires a non-empty `disconfirmation.resultThatWouldRefute`.
- If `denominator.value === 0`, `evidenceClass` is forced to `unmeasured`.
- If the author cannot name a refuting result, the line is stored as `hypothesis`.
- `manual` evidence is allowed, but it still names what would have refuted it.

## 4. Admission Rules

### 4.1 Learning apply gate

Extend `POST /evolution/learnings/:id/apply` so consequence-bearing learnings cannot be marked
applied unless their evidence lines contain at least one `evidenceClass: 'evidence'` entry for the
behavioral consequence being applied.

A learning is consequence-bearing when either:

- it sets `consequenceAsserted: true`, or
- a conservative keyword pass sees causal or behavioral claims in the title or description
  (`cannot`, `prevents`, `reclaims`, `blocks`, `allows`, `fires`, `never`, `always`, `because`,
  `therefore`, `so`, `results in`, `leads to`, `causes`).

If ambiguous, require evidence. A false demand costs one verification trip; a false exemption lets a
producer artifact masquerade as behavior.

### 4.2 Proposal admission

New proposals may include hypothesis lines, but a proposal cannot move from `proposed` to
`approved` when its central claim is consequence-bearing and every supporting line is `hypothesis`
or `unmeasured`.

The approving surface must show the blocking lines and their missing fields, not a generic
validation failure.

### 4.3 Compatibility

Existing records without structured evidence are grandfathered for reading, but not for new status
transitions that assert implementation or application. The first write after upgrade backfills:

```json
{
  "evidenceClass": "hypothesis",
  "disconfirmation": {
    "resultThatWouldRefute": "",
    "probePerformed": false
  }
}
```

That is intentionally not enough to pass the gate.

## 5. HTTP Evidence Preflight

Any HTTP-based evidence line with `evidenceClass: 'evidence'` must run an instrument check before
the route's result is quoted.

The check needs two controls:

1. a known-present case, and
2. a known-absent case.

The route must return meaningfully different results for the two controls. If it does not, the
instrument is constant for the purpose at hand and the evidence line is stored as `hypothesis`.

For collection routes where an id-specific absent case is not natural, the control may be a query or
fixture that changes the response in a predictable way. The point is not the exact shape of the
control; it is that the instrument proves it has at least two states before its answer is treated as
evidence.

## 6. Ratio And Verdict Rendering

Every ratio or verdict surface involved in evolution evidence must display the denominator beside
the numerator.

Examples:

```json
{ "label": "completion verifier fired", "fired": 0, "classified": 0, "state": "unmeasured" }
{ "label": "completion verifier fired", "fired": 0, "classified": 42, "state": "measured" }
```

Rendering rule:

- denominator `0` renders as `unmeasured`,
- denominator `> 0` may render the ratio or verdict, and
- a zero numerator with a non-zero denominator is different from a zero numerator with no
  denominator.

This applies to dashboards, CLI summaries, private views, and generated reports that feed evolution
records.

## 7. Consumer-Graded Audits

An audit that claims "this artifact works" must inspect the consumer that reads the artifact.

Allowed producer checks:

- file exists,
- JSON parses,
- frontmatter is present,
- schema validates,
- non-empty content.

These checks prove artifact health only. They do not prove behavior.

Consumer evidence examples:

- boot log or hook trace showing the file was read this boot,
- live process argv showing a permission flag reached the process that enforces it,
- rendered output showing the selected slice is visible to the user,
- store query against the exact capped, filtered, or ranked window the consumer reads.

If the consumer cannot be inspected, the audit outcome is `hypothesis` or `unmeasured`, not pass.

## 8. Implementation Plan

1. Add the `EvolutionEvidenceLine` type and optional `evidence`, `consequenceAsserted`, and
   `evidenceSummary` fields to learning and proposal records.
2. Add pure validators for consequence detection, disconfirmation completeness, denominator state,
   and HTTP preflight result classification.
3. Extend `/evolution/learnings/:id/apply` and proposal status transitions with the admission rules.
4. Update the producer paths that create learnings and proposals to accept structured evidence and
   to preserve existing text descriptions unchanged.
5. Update dashboards, private evolution reports, and CLI summaries to render denominator state and
   unmeasured verdicts explicitly.
6. Add migration/backfill handling so existing records remain readable, while new status transitions
   require the new evidence shape.

## 9. Tests

Unit tests:

- consequence keyword detection covers both sides of the boundary,
- missing disconfirmation blocks `evidenceClass: 'evidence'`,
- denominator zero forces `unmeasured`,
- HTTP preflight classifies same-result controls as non-disconfirming,
- grandfathered records are readable but fail new consequence-bearing transitions.

Integration tests:

- `POST /evolution/learnings/:id/apply` rejects a consequence-bearing learning with only hypothesis
  evidence,
- the same route accepts a learning with complete consumer evidence,
- `PATCH /evolution/proposals/:id` refuses approval when a consequence-bearing proposal has no
  disconfirmable evidence,
- HTTP evidence against a route that returns the same status/body for present and absent controls is
  stored as hypothesis.

E2E lifecycle:

- initialize a production-shaped agent server,
- create a consequence-bearing learning,
- attempt to apply it without disconfirming evidence and observe the typed refusal,
- add complete evidence,
- apply it successfully,
- verify the dashboard/evolution surface renders numerator and denominator.

## 10. Non-Deferral

The data model and the gates ship together. Adding optional evidence fields without using them in
status transitions repeats the same failure in a more elaborate form: it creates a symbol for
evidence quality that behavior never consumes.

The HTTP preflight may be limited to evolution-generated evidence in the first build, but the
validator must be reusable so other report producers can adopt it without duplicating route-control
logic.

## 11. Open Questions

1. Should proposal creation itself require structured evidence, or should the requirement begin only
   at approval?
2. Should old approved proposals with no structured evidence be blocked from implementation status,
   or should the first implementation pass be allowed to attach the missing evidence and proceed?
3. Which existing reports are in-scope for the first denominator-rendering pass beyond evolution
   surfaces?
