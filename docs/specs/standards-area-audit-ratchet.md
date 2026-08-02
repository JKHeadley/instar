---
title: "Standards Enforcement Coverage Is Ratcheted Per Fundamental Area"
slug: "standards-area-audit-ratchet"
author: "instar-codey"
parent-principle: "Structure beats Willpower"
eli16-overview: "standards-area-audit-ratchet.eli16.md"
lessons-engaged: "Structure beats Willpower; Iterative Audit to Convergence; Verify the State, Not Its Symbol; Honest Denominators; Probe the Concept, Not the Name"
approved: true
approved-by: "echo (standing operator mandate, Justin, topic 29723)"
approved-date: "2026-08-01"
review-convergence: "2026-08-01T07:31:10.091Z"
review-iterations: 6
review-completed-at: "2026-08-01T07:31:10.091Z"
review-report: "docs/specs/reports/standards-area-audit-ratchet-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 10
---

# Standards enforcement coverage is ratcheted per fundamental area

## Operator intent

Round 2, Tier 3 items 5 and 6 ask for a converging audit on a cadence per
fundamental area, coverage tracked as a first-class fact, and a check that fails
when an area goes unaudited. The existing `family` field is the fundamental-area
substrate: it is parsed from the committed Standards Registry and currently has
six values. This change must extend that substrate, not invent a parallel area
taxonomy.

Here, “went unaudited” has two deliberately different consequences. A changed
area without evidence for its current bytes is unaudited in the correctness sense
and fails CI immediately. An unchanged area whose semantic review is old is due
for attention and is durably resurfaced, but age alone never claims the content
is wrong. That split implements the operator's explicit preference for a measured
ratchet over a date-expiry blocking wall.

## Grounded current state

On released main at `deb72dec4`, `scripts/standards-coverage.mjs` reads all 82
standards and reports 58 with a resolvable ratchet, gate, or lint reference:
`0.7073`. It checks only this aggregate ratio. The standard list already carries
`family`, so per-family ratios are deterministic, but there is no committed floor
or last-audited fact for any family.

The one-article Root family reports zero because **Structure beats Willpower**
does not name the ratchet that enforces its own rule. The machinery exists:
`scripts/standards-coverage.mjs` is run by the `Standards Enforcement Coverage`
CI job and fails below its committed aggregate floor. The registry citation is
therefore missing evidence, not missing machinery.

“Enforcement coverage” is the established report name, but its general metric is
only a resolvable named-reference proxy. It does not prove every referenced guard
is effective. This change adds one stronger, narrow invariant for the Root's own
claim: a full-checkout pass also verifies that the repository CI workflow has
unfiltered push and pull-request triggers targeting `main` and that its
`standards-coverage` job actually invokes exactly this script with `--check`.
Job/step conditions, failure-swallowing settings, and shell suffixes do not count
as wiring.

The proof uses the repository's YAML parser, not text matching, so quoted keys,
comments, filters, dependencies, alternate checkout refs, defaults, and
expression-valued conditions cannot masquerade as the required mapping. The
job's pre-check prefix is closed: candidate checkout with full history,
Node/dependency setup without lifecycle scripts, exact protected-base extraction,
then the exact unconditional check step with only the required base environment.
The accepted `on` mapping is exactly `push: { branches: [main] }`,
`pull_request: { branches: [main] }`, and empty `workflow_dispatch`; “unfiltered”
means no path or activity-type filters beyond that required branch selector.
`pull_request_target`, `merge_group`, schedules, and reusable-workflow indirection
are rejected until they receive explicit protected-base semantics.

## Decisions

### 1. `family` is the area identity

No new fundamental-area registry is added. Every structurally parsed family is
an area. The audit ledger must have exactly the same keys as the current parsed
family set; a missing or extra key is a blocking schema error. A newly added
family therefore cannot disappear into the aggregate denominator.

Once committed, a family name is a stable policy identity. Record mode refuses
rename or removal, and protected-base comparison rejects either in CI. This
version deliberately ships no generic retirement bypass: a legitimate future
rename/removal requires a reviewed, versioned schema migration that carries the
old floor forward. New families require explicit `--admit-new-areas` and may not
enter below the aggregate `0.70` floor, so an all-gap family cannot establish a
zero baseline.

CI requires the protected base commit to resolve. It permits a missing base
ledger only for the narrow schema-v2 bootstrap where that commit genuinely has
no ledger; once present, a missing, unreadable, or wrong-schema extracted base is
a check failure rather than a silent loss of monotonicity.

A future lifecycle migration is not implemented, but its minimum carry-forward
contract is fixed: increment the ledger schema; name the old key and exactly one
replacement key or tombstone; carry the exact old floor without reduction; bind
the prior audit digest/evidence plus new review evidence; and make protected-base
CI validate the transition. A rename may change the label, never erase its policy
history.

Operationally, the Standards Coverage job uses `actions/checkout` with full
history. Pull requests compare the candidate ledger to the PR base SHA, pushes to
`main` compare to the event's `before` SHA, and manual dispatch compares to
`HEAD^`. The workflow first proves that commit resolves, then extracts the base
ledger into runner-temporary storage. Local/dev runs with no base-file contract
report `protectedBaseStatus: not-assessed`; they can exercise candidate-tree
checks but cannot claim monotonicity against protected main.

Like every repository-owned workflow, this validator observes the checkout it is
given; it cannot authenticate its own candidate workflow if an already-trusted
control plane deliberately checks out different bytes. Repository review/ruleset
protection of `.github/workflows/ci.yml` is the outer trust boundary. Within the
default candidate checkout, the semantic validator rejects a `ref` override and
any missing or altered monotonic-base wiring. This is drift defense, not a claim
that repository code authenticates the platform executing it.
It is also only as strong as review of the validator itself: the adversarial
fixture suite pins each accepted semantic mapping and its known bypass classes,
while ordinary code review remains the arbiter for validator changes.

Those are the supported event topologies. A squash merge is covered by the
`push` event's exact `before` commit. A force-push whose `before` object is no
longer fetchable fails closed at commit resolution. A repository's first commit
has no meaningful predecessor and is outside the post-bootstrap contract.
`merge_group` is not a configured trigger; if enabled later, it must first define
and test a protected base instead of silently borrowing another event's rule.

### 2. Audit facts are committed, not inferred from Git edits

`docs/standards-registry-area-audits.json` is the source of truth. Each area has:

```json
{
  "lastAuditedAt": "RFC-3339 timestamp",
  "auditRef": "docs/audits/...json",
  "auditSha256": "sha256 of the evidence artifact bytes",
  "areaSha256": "versioned sha256 of the exact H2 family section bytes",
  "refResolutionFloor": { "enforced": 20, "total": 30 }
}
```

Git history is rejected as the audit source because an edit is not an audit. `auditRef`
must resolve to a regular, non-symlink JSON evidence artifact under `docs/audits/`.
That artifact enumerates every accepted family digest and binds the convergence
report bytes with `convergenceSha256`; each ledger row binds the artifact bytes
with `auditSha256`. A convenient path symbol, later-edited report, or artifact
that omits the selected family therefore cannot green the gate. Editing the
family section makes its record stale until explicit record mode consumes
matching evidence.

The evidence artifact schema is deliberately small and closed:

```json
{
  "schemaVersion": 1,
  "reviewedAt": "RFC-3339 timestamp equal to the ledger event",
  "reviewers": ["reviewer identity/source"],
  "findingDisposition": {
    "noUnresolvedDesign": true,
    "resolvedFindings": 17
  },
  "convergenceReport": "docs/specs/reports/...-convergence.md",
  "convergenceSha256": "sha256 of that report",
  "areas": {
    "The Root": { "areaSha256": "...", "verdict": "accepted" }
  }
}
```

Keys and verdict vocabulary are exact; timestamps, hashes, stable reviewer/source identifiers, finding
disposition, and every evidence area entry/digest are validated universally.
An artifact may name only families in the current closed ledger, and one artifact
may cover multiple families only when it explicitly accepts each one. `reviewers`
and `findingDisposition` prevent a silent mechanical no-op from masquerading as
a completed convergence read. The JSON is an index; the byte-bound convergence
report carries the substantive per-round findings and dispositions. This is
byte-bound **review-claim evidence**, not
cryptographic proof that the named reviewers acted; its semantic honesty and
adequacy remain code-review judgment.

CI therefore attests evidence integrity, never reviewer authority. Repository
review requirements and branch protection are deployment controls outside this
portable checkout; this schema neither fabricates nor claims their state. The
convergence report supplies the durable reviewer/source trail that a human review
must inspect before accepting the ledger update.

The digest contract is exact and versioned: the shared structural parser returns
each H2 section's raw decoded text from the `##` heading through the character
before the next visible H2 (or EOF), preserving article order, headings, newlines,
introductory prose, comments, and fenced examples. If duplicate H2 sections
normalize to one `family` key, their raw strings remain in registry order. The
CRLF and lone CR are canonicalized to LF before registry, ledger, evidence, and
convergence-report comparison or hashing so identical Git content has one result
on every checkout. The area digest is sha256 of the UTF-8 bytes for the literal version prefix
`standards-area-audit-v1`, one NUL byte, and `JSON.stringify(sectionStrings)`.
This intentionally stales on contextual prose and formatting changes because the
fact claims an area review, not merely a path-extractor run. Splitting semantic
and presentation hashes was rejected: deciding whether constitutional prose is
semantic is itself judgment, and a supposedly editorial change can alter the
instruction humans and agents act on. The bounded explicit recorder is preferred
to a false-negative semantic filter.

The expected editorial workflow is deliberately short: edit the registry,
review the area diff, finalize the convergence report/evidence, then record the
selected family. Record mode is cheap after that judgment, but it never replaces
the judgment just because a diff looks cosmetic.

### 3. Cadence is event/content based, not a date-expiry wall

The CI check rejects a missing or stale audit record, but it does not reject a
record merely because its timestamp is old. An absolute weekly/monthly expiry
would turn red without a semantic change and would predictably become a disabled
permanent failure. `lastAuditedAt` remains a first-class fact.

Cadence is supplied by `.github/workflows/standards-area-audit-cadence.yml`, which
re-runs the same six-family measurement every Monday, writes a job summary,
uploads the hidden report with missing-artifact failure enabled, and maintains
one durable GitHub issue when any semantic audit is 90 days old. Every pull
request also runs the check. The 90-day signal only resurfaces work: it never
changes check exit status. The blocking invariant is content freshness plus the
measured ratio floor.

The workflow owns issue marker `standards-area-audit-cadence:v1`. Under a
concurrency key it paginates all issues, selects only a non-PR issue carrying that
marker and the stable title, reopens and updates that same issue when areas are
due, and closes it when none are due. Family names are escaped and mentions
neutralized. Closed cycles therefore reuse one durable issue instead of
accumulating history or touching a human same-title issue.

Ownership requires all three signals: exact title, marker at the first body line,
and `github-actions[bot]` as author. A human-authored issue that copies the public
title and marker is never selected, updated, or closed.

Issue maintenance is the cadence signal's delivery mechanism, so it fails loud:
permission denial, disabled issues, rate limits, API errors, or create/update/close
failure propagate as a failed scheduled job and remain visible in Actions. The
step has no catch-and-ignore path. That operational failure still does not turn
elapsed age into a content-correctness veto.

### 4. Floors are a map, not one minimum scalar

Each family has its own exact rational `refResolutionFloor`. A single minimum across
families would protect only the currently weakest family: a stronger family
could regress while the minimum remained unchanged. A map catches a regression
in any family independently and names the exact family that failed.

The existing aggregate `0.70` floor remains in force. Per-family floors are
additional, never a replacement.

### 5. The Root is not exempt

After **Structure beats Willpower** cites the real coverage ratchet, The Root is
1/1. Its floor is `1`. The 0-or-1 granularity is the useful signal for a
foundational singleton: removing its only named mechanism must fail rather than
being averaged away by 81 unrelated standards.

### 6. Recording is an explicit mode of the existing auditor

`scripts/standards-coverage.mjs --record-area-audit=<family|all>
--audit-ref=<evidence.json>` records the current digest, evidence reference, and
the evidence artifact's `reviewedAt`, and raises that area's floor to the current
ratio when the ratio improved.
It refuses an absent/out-of-jail/symlink/mismatched artifact, including a regular
file reached through any symlinked jail/descendant ancestor or Windows-style separator traversal,
more than five minutes of future clock skew, or backward time, and never lowers a previous floor. A
timestamp within the five-minute tolerance can make reported age briefly negative but has no blocking
age semantics. Normal report/check modes do not mutate
the committed ledger. Exact integer cross-multiplication enforces ratios without
four-decimal rounding gaps, including aggregate checks and new-area admission.

A 1.0 family adding an unguarded standard is intentionally rejected. A new
constitutional obligation must arrive with a named guard. Neither record mode nor
a direct candidate-ledger edit is an accepted-debt bypass; protected-base CI
rejects every floor decrease.

### Rejected alternatives

Diff coverage protects changed lines, not the continuing floor of an unchanged
small family. A single per-component minimum repeats the weakest-family masking
problem. CODEOWNERS can require a reviewer for paths but cannot bind the reviewed
family bytes or ratio. Existing coverage-threshold patterns still motivate the
ratchet shape; the ledger is the missing constitution-specific identity, evidence,
and last-audited layer. No rename/retirement record is pre-designed here because
shipping an unused migration escape hatch would create the exact floor-reset
bypass this version closes; its first legitimate use must define and test a
versioned carry-forward contract.

An additional immutable slug plus mutable display label was rejected for this
version because `family` is already the requested first-class substrate and the
registry has only six human-readable keys. A second identity namespace would add
mapping drift precisely where exact ledger/registry closure is meant to remove
it. The explicit versioned migration contract makes the rare editorial rename
cost visible and carries its policy history forward.

Signed SLSA/in-toto-style attestations and an external append-only audit service
were also rejected for this repository-local governance fact. They would add key
custody, availability, and network authority without proving semantic review
quality. Canonical committed JSON is portable, diffable, and protected by the
same review boundary as the constitution; it is deliberately an integrity-bound
claim, not a signature-backed identity assertion.

### Glossary

- **Root-less:** missing the one Rule-bearing `The Root` family section.
- **Protected base:** the trusted comparison commit for the current CI event.
- **Runtime auditor:** `StandardsEnforcementAuditor`, which serves diagnostic
  coverage from the packed constitution but does not hold this source CI authority.
- **False claim:** registry prose that asserts running machinery while naming no
  resolvable guard.
- **Evidence jail:** the real `docs/audits/` directory allowed for audit claims;
  lexical escapes, backslashes, a symlinked jail component, descendant ancestor,
  or final entry are rejected.

Example: Building measures 24 guarded references over 30 standards. Its exact
floor is also 24/30 and its current area digest matches the evidence, so it passes.
If one guard stops resolving, 23/30 is below 24/30 and Building fails even if the
whole registry remains above 0.70. `refResolutionRatio` is the rounded display of
that exact named-reference fraction, never proof that the cited guard executed.

## Decision points touched

| Decision point | Classification | Justification / floor / arbiter |
|---|---|---|
| Whether the ledger covers the registry's family set | `invariant` | Both sides are finite exact string sets derived from the same candidate tree. Equality is mechanically decidable; there are no competing live signals. |
| Whether a record matches current family content | `invariant` | Equality of two full sha256 values over the specified bytes is mechanically decidable. Invalid or missing inputs remain explicit errors. |
| Whether a measured family passes its floor | `invariant` | Both values are bounded numbers and the only admissible action is pass at `actual >= floor`, fail below it. This is deterministic policy, not an inference about meaning. |
| Whether any candidate may lower a floor | `invariant` | It may not. Record mode uses `max(previous, current)`, and protected-base CI rejects a lower candidate ledger even if edited directly. Malformed or unavailable prior state refuses the comparison. |
| Whether an area identity can reset | `invariant` | Protected-base comparison forbids removal, rename, time reversal, and floor decrease. New admission is explicit and must begin at or above 0.70. A future retirement requires a new versioned migration contract. |
| Whether an audit was semantically adequate | `judgment-candidate` | The deterministic floor is exact family identity, current full-section digest, a jailed review-artifact reference, measured ratio, and no floor decrease. The PR/spec reviewer is the arbiter above that floor. If judgment is unavailable, the record stays missing/stale and CI remains red; the script never fabricates approval. |
| Whether elapsed age alone should block | `invariant` (negative authority) | It never blocks. Age has no enumerated correctness threshold and therefore remains report data for a scheduler/reviewer rather than becoming a brittle authority. |

## Evidence contract — Verify the State, Not Its Symbol

| Instrument | Symbol read | State it actually establishes | Corroboration and unmeasurable result |
|---|---|---|---|
| Family inventory | structurally parsed H2 family names containing Rule-bearing H3 articles | the exact family denominator in the registry bytes being checked | Full-checkout checks fail on missing, empty, or Root-less registries. Only explicit `--allow-partial-registry` produces non-assessment. Per-family parity compares the source script with the runtime auditor. |
| `refResolutionRatio` | a named file/route/symbol resolves in the candidate tree | only that the standard's named enforcement reference exists, not that a test executed or is strong | Per-kind counts, gap names, dangling refs, and a real planted-file suite make the arithmetic inspectable. Unreadable/missing guard evidence resolves false and fails the floor/dangling gates rather than becoming a flattering value. For the Root's self-reference only, a semantic YAML invariant also verifies unfiltered CI push/PR-to-main triggers, candidate full-history checkout, exact protected-base wiring, and an unconditional, failure-propagating exact `--check` invocation. |
| `areaSha256` equality | versioned sha256 of the exact raw H2 family section(s) | the committed audit event names the same complete family bytes now being graded | The current digest is recomputed independently from the ledger on every run and both values are exposed. Missing/invalid ledgers are explicit errors; no timestamp or previous generated report substitutes for the digest. This does not claim semantic review quality. |
| `auditRef` + hashes | a normalized JSON path, its byte hash, accepted family/digest rows, and a byte-bound convergence report | the candidate tree carries immutable evidence for this exact family state | Any path, artifact, report, family, digest, timestamp, or verdict mismatch fails. Semantic adequacy remains reviewer judgment above this deterministic evidence floor. |
| `lastAuditedAt` | a canonical RFC-3339 string written by explicit record mode | only the declared time of that content-bound audit event | Invalid, more-than-five-minutes-future, or backward time is rejected. Age at 90 days opens or refreshes one nonblocking review-due issue; it never changes the audited verdict or check exit status. |

## Frontloaded Decisions

1. `family` is the only area identity; no parallel taxonomy.
2. Audit facts live in committed canonical JSON, not Git edit history.
3. Content freshness blocks; elapsed age does not.
4. Floors are a per-family map plus the retained aggregate floor.
5. The Root is included at its measured singleton floor.
6. The recorder is explicit, byte-bound, atomic, exact-family scoped, and non-lowering; area lifecycle cannot reset floors.

## Open questions

*(none)*

## Multi-machine posture

**Unified through source control.** Registry bytes, the audit ledger and evidence, the script,
the weekly workflow, and the CI policy ship in the same Git commit, so every machine on that commit
derives identical families, LF-canonical digests, ratios, and floors. There is no machine-local
credential, hardware binding, or runtime write store. The scheduled due issue is
shared repository state, bounded to one marker-owned issue, and therefore follows
the source project rather than a topic or machine. The explicit record command
mutates the authoring working tree, but its result has no authority until ordinary
Git review/merge replicates it. The packed
runtime auditor exposes matching per-family measurements for API consumers; the
blocking ledger remains source-checkout governance and is not claimed as a runtime
gate in installed agent homes.

## Report and check contract

The JSON report gains an `areas` map. Every entry includes the measured total,
enforced count, per-kind counts, ratio, gaps, current content digest, committed
floor, last-audited time, and whether the committed digest matches. The text
report prints one line per family.

When the registry exists, `--check` fails for any of these conditions:

1. the audit ledger is missing, malformed, or uses an unsupported schema;
2. the ledger and parsed family sets differ;
3. a timestamp, evidence/report reference or byte hash, digest, or exact floor has an invalid type or bound;
4. a family's current digest differs from its audited digest;
5. a family's current ref-resolution ratio is below its floor;
6. a full checkout is missing/empty/Root-less, the Root's CI self-wiring is absent,
   a protected-base family disappears, its time moves backward, its floor decreases,
   or a new area enters below 0.70;
7. any existing aggregate, dangling-reference, false-claim, or unknown-section
   condition fails.

A deliberately partial checkout must pass `--allow-partial-registry`; without that
explicit declaration, missing registry state fails closed rather than posing as a
successful zero-area check.

## Root proof

The Root article will name `scripts/standards-coverage.mjs` and its CI wiring in
`.github/workflows/ci.yml`. The same real auditor must then classify The Root as
ratchet-backed, raising the measured aggregate ratio from the actual run rather
than from a predicted constant. Full-checkout mode additionally fails if that
workflow loses unfiltered push/PR-to-main triggers or the standards job stops
invoking the exact script command unconditionally in failure-propagating
`--check` mode, or if checkout/base extraction changes. This proves the candidate
checkout's repository wiring, not hosted branch-protection/control-plane state.
A real-registry test pins the Root entry, the six-family ledger closure, zero
stale records, the self-wiring invariant, and the post-change ratios.

## Tests

- Existing aggregate, dangling, false-claim, and heading-scope tests remain green.
- A dominant family keeps the aggregate green while a singleton family regresses;
  only the new per-family floor catches it.
- Missing, extra, malformed, and stale audit records fail with the family named.
- Adding or editing a family without recording a new digest fails.
- Recording one family changes only that record and never lowers its exact floor.
- Immutable evidence (including symlinked jail roots/descendants and backslash traversal),
  base-floor monotonicity, rename/removal refusal, new-family admission,
  adversarial map keys, CRLF parity, and parser span boundaries are pinned.
- The live Root has no exemption and is ratchet-backed at 1/1; comment/name-only
  command decoys, shell recovery suffixes, conditions, failure swallowing, and
  filtered/misplaced triggers, dependencies, pre-check steps, or checkout
  redirection do not satisfy wiring. The cadence marker additionally pins bot authorship.
- Missing/empty/Root-less full checkouts fail; explicit partial mode is non-assessed.

## Rollback

Revert the script, shared parser/runtime measurement, both workflows, Root citation,
ledger/evidence, tests, and release fragment as one patch release, and close the
marker-owned scheduled review-due issue if it is open. The ledger is inert JSON
to older versions. No runtime state migration is required.
