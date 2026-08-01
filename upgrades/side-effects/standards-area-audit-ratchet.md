# Side-Effects Review — Standards Area Audit Ratchet

**Version / slug:** `standards-area-audit-ratchet`  
**Date:** `2026-08-01`  
**Author:** Instar-codey  
**Review posture:** converged security, adversarial, integration, scalability,
and decision-completeness review; dedicated independent second-pass concurred
after class-closure correction

## Summary

The coverage audit now treats every registry `family` as a fundamental area. A
canonical ledger binds each area's time, exact integer floor, full-section digest,
and immutable audit-evidence bytes. Source CI retains the aggregate bar and adds
per-area enforcement; the packed runtime auditor exposes matching per-family
measurements. The Root article cites the actual CI ratchet.

## Decision-point inventory

- area identity — **reuse `family`, then stabilize** — no parallel taxonomy;
  rename/removal cannot reset policy.
- audit fact — **committed ledger plus byte-bound evidence** — a path or Git edit
  alone is not proof.
- floor — **exact rational per family** — integer cross-multiplication avoids
  rounding loss.
- cadence — **scheduled advisory lifecycle** — 90-day issue resurfacing, never an
  age-based CI veto.
- product scope — **measurement parity, authority separation** — runtime API gets
  areas; source-only ledger remains CI governance.

## 1. Over-block

Any full H2 edit stales its area, including explanatory formatting. That is
intentional because the audit claims review of the constitutional area, not only
its extracted paths. A family rename/removal is rejected rather than treated as
new identity; a legitimate lifecycle change needs a future versioned migration.
New families must start at or above 70%, so a knowingly weak new area must ship
guards rather than normalize zero. Deliberate partial checkouts retain an explicit
`--allow-partial-registry` non-assessment lane.

## 2. Under-block

Cryptographic binding proves which bytes and family digests were attested, not
that semantic judgment was wise. That remains reviewer authority above the
deterministic floor. Protected-base comparison prevents direct floor lowering,
time reversal, and identity deletion in CI; record mode cannot perform them.
The measurement remains named-reference existence, not proof that a named test
ran or asserts strongly.

## 3. Level-of-abstraction fit

Per-family measurement is derived once from per-standard results in both the
self-contained CI script and runtime auditor, with parity tests over membership,
counts, kinds, ratios, and gaps. The audit ledger stays beside the authored
registry because installed agent homes do not own source-governance authority.

## 4. Signal vs authority

Closed facts hold authority: registry presence/Root invariant, exact family set,
schema, byte hashes, accepted family/digest evidence, exact floor comparison, and
protected-base monotonicity. Audit age is signal only. The weekly workflow writes
a summary and maintains one due issue, but never changes check exit status.

## 4b. Judgment within floors

The artifact binds a convergence report and accepted digests so the mechanical
floor cannot be satisfied by an unrelated file. Reviewers still decide semantic
adequacy. If evidence is missing or inconsistent, the script does not invent an
approval; the record remains invalid.

## 5. Interactions

- Aggregate, dangling, false-claim, and unknown-heading gates remain additive.
- Root citation changes the real count from 58/82 to 59/82 (0.7195).
- Shared-parser CRLF normalization makes one Git tree hash identically across
  checkout policies while preserving exact raw spans for evidence.
- Workflow artifacts explicitly include hidden files and fail when absent.
- Scheduled issue writes are concurrency-serialized and bounded to one hidden
  marker-owned issue found through pagination. Ownership requires the exact
  title, the marker on the first line, and `github-actions[bot]` authorship;
  human same-title or forged-marker issues are never updated or closed. It
  closes automatically when no area is due.
- Normal report/check modes never mutate the ledger; record mode uses unique temp
  plus atomic rename.
- Root source-CI wiring is parsed as YAML and matched structurally: exact events,
  exact first five job steps, full-history checkout, Node 20,
  `npm ci --ignore-scripts`, protected-base resolution, and the exact check
  invocation. Alternate refs, filters, conditions, shell suffixes, extra events,
  and decoy text do not count as wiring.

## 6. External surfaces

The runtime coverage response adds `summary.areas`. GitHub Actions gains a weekly
nonblocking due-issue lifecycle and two reliable report artifacts. No user data,
credentials, runtime database, message-routing authority, or agent-home state is
added. The candidate-tree YAML check proves that reviewed workflow bytes still
contain the intended wiring; GitHub branch protection and required-check settings
remain control-plane authority outside the repository and are not authenticated
by this change.

## 7. Multi-machine posture

CRLF is normalized before digesting. Ledger, evidence, convergence report,
registry, and policy ship in one commit. Machines on that commit derive identical
keys, hashes, exact fractions, and floors. The scheduled GitHub issue is shared
repository state, not machine-local authority.

## 8. Rollback

Revert the shared parser/runtime measurement, coverage script, both workflows,
Root citation, ledger/evidence, tests, and release artifacts together. Older
versions ignore the ledger. Close any still-open scheduled review-due issue after
rollback; no runtime data repair is required.

## Conclusion

The change closes aggregate masking without a second taxonomy or date-expiry
wall. Tests plant the original blind spot plus evidence mutation, identity reset,
weak-family admission, special object keys, CRLF, missing/empty/Root-less input,
parser boundaries, and source/runtime parity.

## Evidence

- `docs/specs/standards-area-audit-ratchet.md`
- `docs/audits/standards-area-audit-2026-08-01.json`
- `scripts/standards-coverage.mjs`
- `tests/unit/standards-coverage-ratchet.test.ts`

## Dedicated second-pass review

The independent lifecycle/security pass found no code or workflow side-effect
defect. It did catch one governance overclaim: this candidate introduced
`aggregate-masks-subgroup-regression` while labeling it already confirmed and
guard-closed. Operator confirmation had not occurred. The registry now enters
the class as `unconfirmed`, tracked action `ACT-360` holds the confirmation gap,
and the machine-readable declaration uses the required novel-class semantics.

Final independent second-pass re-review concurs. The corrected registry, live
ACT-360 operator-confirmation gap, display mirror, and machine-readable trace
agree on novel/unconfirmed/gap authority. No unresolved side-effect finding
remains across interactions, blast radius, security, reversibility, semantic
Root workflow wiring, dependency lifecycle suppression, bot-owned issue
mutation, runtime/source authority separation, or the outer GitHub control-plane
boundary.

## Class-Closure Declaration

`defectClass: novel`, `closure: gap`, `gapItem: ACT-360`, `component:
standards-coverage`, `novelClass: { nearestExistingClass:
unknown-classification-fail-open — both can let an unsafe state pass, but this
class hides a known subgroup regression through aggregation rather than
permissively classifying unknown input, includes: [a coverage ratio that gates
only the whole population even though each declared family is independently
load-bearing, a large subgroup compensating numerically for a smaller subgroup
losing its only enforced item, a global floor presented as regression protection
while no per-subgroup floor exists], excludes: [a population with no stable or
meaningful subgroup identity, a dashboard-only aggregate that holds no pass/fail
authority, an aggregate whose contract deliberately allows substitution among
fungible members], severity: normal }`.

The implemented per-area ratchet is real enforcement, but the novel class remains
gap-closed until the operator confirms that class identity; only then may a later
decision audit cite the ratchet as class-level guard closure.
