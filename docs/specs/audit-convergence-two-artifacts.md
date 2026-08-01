---
title: "Audit Convergence Requires Fixes and the Blind-Spot/Standard Artifact"
slug: "audit-convergence-two-artifacts"
author: "instar-codey"
parent-principle: "Iterative Audit to Convergence"
eli16-overview: "audit-convergence-two-artifacts.eli16.md"
lessons-engaged: "Structure beats Willpower; Iterative Audit to Convergence; Constitutional Traceability; Signal vs. Authority; Judgment Within Floors; Verify the State, Not Its Symbol; No Deferrals; Close the Loop"
approved: true
review-convergence: "2026-08-01T03:51:51.145Z"
review-iterations: 8
review-completed-at: "2026-08-01T03:51:51.145Z"
review-report: "docs/specs/reports/audit-convergence-two-artifacts-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 7
---

# Audit Convergence Requires Both Artifacts

## Operator intent

The 2026-07-31 Tier-3 mentor dispatch binds this change to the operator's
2026-07-25 definition of a complete audit:

1. a clear path to fixing the issues uncovered; and
2. the insight/meta-insight into how the issues arose, the blind-spot class they
   represent, and the standard created or amended in response.

The current validator closes every finding with a structured disposition and a
standing guard/exemption, but it does not require the second artifact. The first
clause is a declared, reviewable remediation path; the existing validator does
not claim online proof that every external tracking reference exists. This spec
adds the missing meta-artifact without overstating that older contract.

## Grounded current state

`scripts/write-audit-convergence.mjs` currently earns a `converged:` stamp only
when five conditions hold: at least two rounds, a row-cross-checked zero final
round, closed dispositions for every finding, search-angle and surface-delta
records, and a standing guard or closed-enum exemption. Searches for blind-spot,
lesson, takeaway, and meta-insight concepts find no sixth validator condition.

Exactly one committed report carries a non-empty convergence stamp:
`docs/audits/llm-decision-accountability.md`. Compatibility therefore means one
honest backfill, not a grandfathering lane or a forward-only waiver.

The separate Close the Loop item is not changed. Its premise is false on current
source: that registry article already names three live guards and the standards
auditor resolves all three with zero dangling references.

## Proposed design

### Sixth condition: structured identity plus causal narrative

Every stamped report carries these additional managed frontmatter fields:

```yaml
blind-spot-class: "<reusable lowercase slug, 3-64 characters>"
standard-response-kind: "<created|amended|no-change>"
standard-response-ref: "<historical repository standards document path>"
standard-response-article-id: "<stable lowercase slug matching ^[a-z0-9][a-z0-9-]{2,63}$>"
standard-response-article: "<historical article title, 4-240 characters>"
standard-response-rationale: "<why this response is honest, 24-500 characters>"
standard-response-digest: "<sha256 of kind/ref/article-id/article evidence identity>"
meta-artifact-digest: "<sha256 of the current class/response/causal tuple>"
meta-artifact-at: "<ISO timestamp written by the stamp tool>"
```

The report body also carries one exact `## Meta-insight` section before
`## Round 1`, containing two single-line, bounded declarations:

```markdown
## Meta-insight

How it arose: <40-1000 characters>
Why prior controls missed it: <40-1000 characters>
```

This split is deliberate. Whole-audit identity, standard response, and timestamp
belong in duplicate-protected frontmatter. The longer causal explanation belongs
in normal Markdown, where punctuation and quoting are not forced through the
repository's intentionally small YAML-ish parser. Requiring the section before
Round 1 prevents it from being mistaken for a finding row in the final round.

Every author-owned field is mandatory. `blind-spot-class` is an aggregate-ready
slug matching `^[a-z0-9][a-z0-9-]{2,63}$`; reuse of the same slug across audits
is intentional and appears in the merged inventory. Floors reject empty labels
and ceremonial one-word assertions; ceilings keep hook parsing bounded. Lengths
count trimmed JavaScript string code units, matching the existing exemption-
rationale floor. The validator checks structure, not whether the prose is
insightful.

The three derived fields are tool-owned staleness guards, not cryptographic proof
of truth, insight quality, or approval. `standard-response-digest`
hashes a versioned, length-delimited canonical serialization of only
kind/ref/article-id/article: the frozen historical identity that determines
whether article-change evidence is owed. `meta-artifact-digest` hashes the
canonical timestamp plus the class, all response fields including rationale, and
both causal declarations: the identity a semantic reviewer reads.
Serialization is UTF-8 and every length prefix counts bytes, not JavaScript code
units. This split avoids forcing a meaningless registry edit when an author fixes
causal prose, while still invalidating the semantic identity.

Stamp mode is two-phase: validate author-owned bytes while permitting all derived
fields to be absent; render candidate bytes with both digests and a canonical ISO
timestamp; reparse and validate those candidate bytes in memory; then atomically
replace the report via a same-directory temporary file. Stamp mode, the Instar
hook, and CI all receive explicit `requiredStandardsRef` policy. Check, precommit,
and CI require all three derived fields. If any author-owned **meta-artifact** byte
changes, the meta digest no longer matches and restamping refreshes it and the
timestamp. The response digest changes only when the historical response identity
changes. An unchanged valid report is byte-idempotent.

The body parser accepts exactly one real top-level `## Meta-insight`, strictly
before the first real `## Round 1`, and exactly one of each declaration. Headings
or declarations inside fenced code, HTML comments, or blockquotes do not count;
duplicates and continuation-line laundering are refused.

### Honest no-new-constitutional-rule response

`standard-response-kind` is a closed first-class value, never an exemption:

- `created` — the audit's change creates a new standards article.
- `amended` — the audit's change modifies the standards document for the named
  article.
- `no-change` — the existing standard already covers the class and the audit
  exposed an implementation/enforcement gap rather than a missing rule.

`no-change` avoids invented constitutional churn. It still owes the standards
artifact, article name, and rationale, and it is loud: stamp/check output prints a
distinct banner. The merged-state ratchet inventories created/amended/no-change
counts by blind-spot class so repeated reliance is visible. At two or more
`no-change` reports for one class it prints a reviewer warning—“is the standard
adequate but enforcement repeatedly absent?”—without pretending a fixed count can
decide constitutional meaning. Two is fixed as the earliest possible repetition,
not a configurable authority threshold. There is no escape from naming the class
or supplying both causal lines.

### Standard-artifact resolution and change corroboration

`standard-response-ref` is validated with standing-guard-grade containment:

1. repository-relative, under `docs/`, Markdown, no absolute path or `..`;
2. no symlink (including a symlinked final path), contained under the repo root;
3. a regular file present in the applicable evidence snapshot and git-tracked or
   staged;
4. Instar's hook and CI pass the explicit repository policy
   `requiredStandardsRef: docs/STANDARDS-REGISTRY.md`; it never infers Instar mode
   from that file's presence. A repository vendoring the validator may omit or
   configure that option and name its own jailed `docs/**/*.md` standards file.
   Staging deletion/type-change of Instar's registry therefore cannot downgrade
   the checkout into a permissive vendor lane.

Every standards article cited by a stamped audit carries a stable, unique
`**Article ID.** \`lowercase-slug\`` field inside its article block. The audit
freezes that ID, the exact title, and the standards-document path as historical
provenance at convergence time. A later title or path rename does not rewrite the
audit or its response digest. Mechanically, an ID is unique in the standards
snapshot used by a new/changed response. Whether an ID still represents the same
constitutional rule after a later rewrite is reviewer judgment.

Article resolution extracts the dependency-free structural article-block core
from `StandardsRegistryParser` into one source module consumed by the runtime
parser, audit validator, and pre-build standards-coverage gate. It returns stable
IDs, exact titles, and source blocks; wrapper-parity fixtures protect all three
callers. This keeps one grammar authority while remaining usable before a build.
The `.mjs` core ships in the npm package with a TypeScript declaration; compiled
runtime imports, source hooks, and package consumers resolve the same file.
Only true top-level `###` blocks under a real `##` family with a true
top-level `**Rule.**` declaration count as articles. `Article ID` is optional for
legacy unreferenced articles but mandatory on an article an audit cites. Fenced
code, HTML comments, and blockquotes cannot forge an article. Duplicate IDs
anywhere, a missing cited ID, or ambiguous exact names fail closed. A generic
vendor document uses this same grammar unless the embedding caller supplies a
parser with the same `{id?, name, block}` contract. Continuous identity, reuse,
and large semantic rewrites are surfaced in the ordinary standards diff; this
item does not claim a historical ID-allocation ledger.

Snapshot rules are explicit:

- stamp mode compares HEAD with the worktree; precommit compares HEAD with the
  index, including staged-only content and staged deletion/type changes;
- PR CI receives the event's exact base and head SHAs and compares the combined
  candidate change from `merge-base(baseSha, headSha)` to head (so an advancing
  base branch cannot contaminate the candidate diff); push CI receives the
  event's exact `before` and `after` SHAs and validates the full delivered range,
  including a multi-commit push. Missing/unresolvable event objects fail closed;
- every stamped report is structurally revalidated, but standards resolution and
  block-delta corroboration run only for a new report or one whose response digest
  differs across that change. An unchanged response may outlive a later path,
  title, or article deletion because its fields are frozen historical provenance.

For a new or response-identity-changing report, the exact ID/title/path must
resolve in the candidate snapshot. The response matrix is closed:

- `created`: neither the ID nor the exact legacy path/title article exists in the
  base; the candidate contains the new ID/article.
- `amended`: the same ID exists in base and candidate with a substantive block
  delta, or the legacy bootstrap below adds the ID plus a substantive delta.
- `no-change`: the target article exists in base and candidate with no substantive
  block delta; the only allowed delta is the legacy ID-only bootstrap.

Precommit requires report and response in one staged commit; PR CI accepts their
combined merge-base→head diff because safe merge squashes it to one canonical
commit.

Legacy ID-less articles have one bootstrap transition. `created` always requires
an ID in the new block. The first `amended` response locates the base block by
exact path/title and requires the candidate block to add a fresh ID plus a
substantive non-ID delta. The first `no-change` response may add only the fresh ID
as metadata because unchanged constitutional meaning is its claim. Causal/
rationale-only report edits keep the response digest and never demand registry
churn. Article indexes are cached once per distinct base/candidate snapshot.

### Semantic judgment point and fallback

Choosing created/amended/no-change and judging the article's adequacy is a
`judgment-candidate`, not an invariant. Its complete floor is:

- action space is the three response kinds only;
- created/amended require same-change standards evidence;
- no-change requires a historically resolving standards document, stable ID,
  article name, rationale, and loud inventory entry;
- absent or unverifiable structural evidence defaults to **incomplete / no
  structural stamp**.

The named arbiter is the audit-report PR reviewer, reading the full audit,
standards artifact, and diff. That reviewer may narrow a structurally possible
kind by rejecting its rationale; it cannot widen beyond the closed floor. The
stamp certifies structural completeness before the PR exists. Semantic adequacy
remains ordinary current-diff PR review: this item adds no head-bound approval
receipt, does not change merge authority, and does not claim machine proof that a
review occurred or remained fresh. A direct push can therefore pass structural
validation without semantic review; this item does not label that fact semantic
approval. The deterministic validator fallback is only for what it can know: any
structurally invalid or uncorroborated choice is unstamped. No keyword or
heuristic attempts to replace reviewer judgment.

The historical ref/title may later move or disappear without invalidating what
the audit did. A report edit that deliberately rewrites the frozen response
identity is a new provenance claim and must carry fresh change-local
corroboration. The repository's Git commit remains inspectable provenance, but
the ratchet does not reconstruct an attestation engine from arbitrary history.
Merged inventory separately warns when a frozen ref/title/ID no longer resolves
in current HEAD; this does not invalidate the historical convergence claim.

### Backfill provenance

`docs/audits/llm-decision-accountability.md` is enriched honestly:

- class: accountability substrates existed but were not required end-to-end;
- causal explanation: component inventories and isolated mechanisms measured
  presence, not universal provenance, outcome grading, or real-prompt parity;
- `no-change` points to `Decision Provenance & Outcome Review`, because that
  standard already names the class and the audit found missing enforcement.

The original `converged:` timestamp is preserved as the time the five original
conditions were earned. A new managed `meta-artifact-at` timestamp and the two
digests record when the current sixth-condition tuple was added, preventing the
backfill from masquerading as contemporaneous evidence. For a new report, both
timestamps are written together. Re-stamping a valid unchanged report is byte-
idempotent.

This is the only grandfathered backfill. Future post-hoc insertion into an already
converged report requires a named migration spec and its own explicit provenance;
ordinary stamp mode cannot silently synthesize missing author-owned fields.

### Author guidance and fleet delivery

The shared built-in iterative-audit skill and repository skill copy gain the new
field/section contract and the honest `no-change` path. Fresh installs receive the
shared constant through `init.ts`.

The current existing-agent migration incorrectly treats the old
`docs/audits/<slug>.md` marker as “already current,” so it would skip every agent
that received the original convergence feature. The shared skill gains an
explicit version sentinel (`<!-- INSTAR:AUDIT-META-ARTIFACT-V2 -->`), and the
migration keys on that sentinel rather than ordinary prose. It upgrades only
exact known prior stock hash/content, is idempotent once the sentinel exists, and
preserves genuinely customized copies. Direct tests cover prior-stock upgrade,
current-stock no-op, customized skip, and fresh install.

The source policy is unified by git/package updates. Installed `.claude/skills`
copies are deterministic replicas, not authoritative state: the unified package
source and migration define their stock content on every machine. Customized
copies are explicit operator-authored forks preserved by the pre-existing safety
rule, not a new machine-local state surface introduced here.

The `Iterative Audit to Convergence` registry article is amended to name the
sixth condition while retaining its existing guard citations. The original
audit-convergence spec and ELI16 companion receive a dated amendment note.

## Failure behavior

Every refusal names the missing/malformed field and expected shape. The honest
escape is unchanged: remove the `converged:` claim and commit an incomplete
report. Precommit revalidates only staged stamped reports. Merged-state CI
revalidates all stamped reports, so a validator regression can block unrelated
PRs until repaired; this is the deliberate cost of a repository-wide ratchet.

On success, `validateAuditReport` returns the parsed meta-artifact, both current
digests, and response kind. CLI check/stamp output prints the response, with a
distinct `NO-CHANGE` banner when applicable.

## Decision points touched

- `validateAuditReport` meta-artifact form — **invariant** — closed keys, bounds, section shape, reference containment, snapshot type, and same-change evidence are enumerable structural facts.
- Precommit staged-report refusal — **invariant** — consumes the shared validator against index bytes and refuses only an unearned stamp.
- Merged-state audit ratchet — **invariant** — revalidates committed form and digest-bound created/amended article-block evidence.
- Article-ID form/current allocation — **invariant** — a closed lowercase-slug shape and candidate-snapshot uniqueness are enumerable structural facts.
- Article-ID continuity across a rewrite/move — **judgment-candidate** — current uniqueness and continuous presence are the structural floor; PR review is the arbiter, with request-changes as the fallback when identity appears repurposed.
- Standard-response selection and adequacy — **judgment-candidate** — the structural floor, PR-review arbiter, and deterministic unstamp fallback for unmeasurable evidence are defined above; review freshness is outside this item.

## Signal vs. Authority

Per `docs/signal-vs-authority.md`, closed field shape, snapshot existence, path
containment, current digests, and article-block delta are hard invariants and may
block a false stamp. The system does not string-match insight quality or infer
constitutional adequacy. Those meanings go to the named reviewer authority
inside the floor.

## Verify the State, Not Its Symbol

- **Symbols:** managed fields, two causal lines, a frozen standards path/title,
  stable article ID, and a response-digest-bound block delta for created/amended.
- **Claimed state:** a reviewable meta-artifact exists and the constitutional
  response has causal change evidence where change is claimed.
- **Corroboration:** HEAD/index or CI base/head block comparison independently
  ties a new/changed response digest to an exact standards-article change;
  no-change resolves the candidate article and is surfaced for reviewer judgment
  and aggregate visibility.
- **Unmeasurable:** semantic adequacy is never presented as mechanically proven;
  it remains an explicit reviewer concern outside the structural stamp.

## Interactions

- Duplicate-key refusal expands to all nine new managed frontmatter keys.
- `stampConverged` writes both digests and `meta-artifact-at` but never invents
  class, response, article, rationale, or causal prose.
- Precommit gains index-snapshot options; CI gains explicit base/head change
  evidence and the response-kind inventory.
- Secret scanning already covers all new report text.
- Standing guard/exemption says what prevents recurrence; the meta-artifact says
  what class escaped and what the constitution did about it. Neither substitutes
  for the other.
- Standards coverage remains ratchet because existing citations remain live.

## Multi-machine posture

- **Validator/reports/registry/tests — unified via git.** No durable runtime state,
  notice, URL, or topic record is added.
- **Installed skill copies — deterministic replicas, not authoritative state.**
  The unified package source and migration define stock content on every machine;
  customized copies are explicit operator-authored forks preserved by the
  pre-existing safety rule. This spec introduces no machine-local authoritative
  surface, so no `machine-local-justification` marker applies.

## Alternatives considered

A standalone JSON/append-only provenance manifest would give a mature schema
parser, but it would
split one audit's narrative and evidence across two independently editable files
and create a new synchronization invariant. Commit trailers were rejected because
safe squash/rebase/cherry-pick workflows rewrite commit metadata and because the
report itself must remain the durable artifact. A full Markdown AST dependency is
unnecessary for the registry's deliberately constrained dialect and would make
the dependency-free prebuild hook heavier; the extracted existing parser core is
the single grammar authority instead. Embedded bounded fields keep the claim with
the report, while change-local block comparison provides independent
corroboration without a second source of truth or a Git-history attestation engine.
Signed/SLSA attestations and Git notes prove artifact transport or commit identity,
not whether a specific standards block was actually created/amended, and add key
or notes-retention infrastructure disproportionate to a repository-local report.
CODEOWNERS can strengthen review routing but cannot replace structural presence
and block-delta checks; review freshness is honestly outside this item.

## Rollback

Revert and ship the next patch. CI executes the validator from the candidate
change, so a validator regression is repaired by changing the validator and its
fixture in the same hotfix; no unaudited bypass is added. Extra audit-report
frontmatter/body fields are harmless to the older audit parser. `Article ID` is a
new classified registry field, so rollback is atomic: parser/coverage support and
the registry ID fields revert together; running an old standards parser against
the new registry is deliberately unsupported and covered by the rollback test.
The existing report needs no data repair. If the policy itself is
rescinded after agents receive the skill wording, a new version-marker migration
removes/replaces that wording; simply restoring the old marker would strand
already-updated projections. A validator-only defect can be hot-fixed without
removing the policy. No database migration exists.

## Acceptance criteria

1. Missing, duplicate, boundary-invalid, digest-stale, or malformed meta
   fields/causal lines are refused with teaching messages; stamp mode proves its
   two-phase insertion is final-byte valid and byte-idempotent.
2. Every response kind requires a jailed regular tracked/staged standards file,
   stable unique article ID, exact historical title, and rationale.
3. Created/amended fail unless the stable-ID block has the required staged or CI
   base/head delta when the response is new/changed; no-change passes without a
   diff and is loudly inventoried. Mode-only and later-PR stale-evidence bypasses
   fail, as do fresh-ID-on-existing-article `created`, new-article `no-change`, and
   substantively-amended `no-change` disguises.
4. ID-less amended/no-change bootstrap follows the closed rules. Current-snapshot
   uniqueness is mechanical; reuse/continuity remains a surfaced review question.
5. Precommit proves index/worktree disagreement cannot forge the reference:
   staged-only, worktree-only, staged deletion, and symlink cases are covered.
6. The generic vendored-validator fixture can name its own jailed standards doc;
   explicit Instar policy requires `docs/STANDARDS-REGISTRY.md` even when that
   file is staged deleted and an alternate document is offered.
7. The sole stamped report validates after backfill, preserves its convergence
   timestamp, and carries a distinct meta-artifact timestamp. Canonical ISO and
   forged-timestamp fixtures pin derived-field integrity. A real synthetic PR-
   merge fixture uses explicit base/head SHAs, push fixtures use the full event
   before/after range, an advanced-base fixture proves merge-base semantics, and
   a later response-only PR cannot borrow an older registry diff.
8. Workflow fixtures export and resolve exact PR base/head or push before/after
   SHAs into the generic unit command; missing objects fail closed.
9. A causal/rationale-only restamp after the historical article path/title moves
   reuses the unchanged response evidence and does not demand registry churn.
10. Prior stock skill copies upgrade; current stock is idempotent; customized
    copies stay untouched; fresh installs contain the same contract.
11. Registry and canonical spec documentation describe both artifacts; the shared
    article-block core's exact article set stays in parity across callers,
    classifies `Article ID` as metadata, and rejects fenced/commented/quoted
    counterfeits. Package/type-resolution tests prove the same `.mjs` core ships.
12. Atomic stamp tests preserve file mode and clean temporary files on success and
    every failure path.
13. Rollback fixtures prove the older audit validator ignores the additional
    report fields/body and the standards parser/registry field reverts atomically.
14. Lint, build, focused tests, the full unit/integration/E2E lifecycle, wiring
    integrity, semantic-correctness fixtures, and live standards coverage pass.

## Frontloaded Decisions

1. **Schema:** managed frontmatter for identity/response plus one bounded
   `## Meta-insight` body section for causal prose.
2. **No new constitutional rule:** first-class, loud `no-change`, still owing a
   standards artifact, article, and rationale.
3. **Corroboration:** jailed snapshot-correct standards path plus stable article
   ID/title; created/amended additionally require a change-local block delta at
   stamp/precommit and explicit CI base/head validation.
4. **Semantic authority:** structural stamp first, then ordinary current-diff PR
   review inside a closed floor; no new head-bound merge guarantee is claimed.
5. **Compatibility:** backfill the sole stamped report with a separate
   meta-artifact timestamp; no grandfathering.
6. **Portability:** Instar uses its canonical registry; a vendored validator may
   use its own jailed `docs/**/*.md` standards document.
7. **Delivery:** a new per-change migration marker, because the old marker already
   exists on every previously updated agent.

## Open questions

*(none)*
