# Side-Effects Review — Standards area-model adequacy audit

**Version / slug:** `standards-area-model-adequacy`
**Date:** `2026-08-01`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required — repository-only governance data and CI structure; no runtime, messaging, session, coherence, or self-triggered controller path`

## Summary of the change

This change adds a separate evidence lifecycle for periodically reconsidering
whether the Standards Registry's family list is still adequate. The coverage
script now validates a canonical model-review artifact, its earned convergence
report, explicit keep/add/split/merge/retire consideration, the exact parsed
family set, byte hashes, and timestamps. The weekly workflow resurfaces this
review independently from family-content reviews. The initial two-round audit,
record, tests, ELI16, and internal-only release fragment ship atomically. No
runtime `src` file changes.

## Decision-point inventory

- **Area-model evidence validity** — add — a closed repository invariant blocks
  CI when the record is missing, malformed, byte-detached, unconverged, or stale
  for the parsed family set.
- **Semantic area disposition** — pass-through — reviewers choose keep, add,
  split, merge, and retire outcomes; deterministic code never chooses them.
- **Review-age cadence** — modify — a 90-day model-review due signal joins the
  existing content-review signal without gaining blocking authority.
- **Scheduled issue lifecycle** — modify — the existing single marker-owned
  GitHub issue includes whichever content or model review is due.

---

## 1. Over-block

A legitimate registry change that adds, renames, or removes a family now fails
until a convergence-bound area-model review explicitly covers the new exact set.
That is intentional: the former behavior let a taxonomy change land with only a
content attestation. Formatting or wording changes inside a convergence report
also stale its evidence hash and require re-recording. Ordinary per-family
content evidence is deliberately rejected as model evidence even when its date
and reviewers are valid.

Elapsed age does not block. A repository with an unchanged but old review stays
green and receives the existing advisory issue instead, avoiding a calendar wall
that could veto unrelated work.

---

## 2. Under-block

The checker cannot prove that a rationale is intellectually good or that a
reviewer explored every meaningful alternative. It proves that all current
families have one allowed disposition, additions are explicit, all five actions
were reviewed, the evidence matches an earned convergence report, and no design
finding remains open. Semantic adequacy remains reasoning authority in the
review report.

The 90-day interval is a resurfacing cadence, not proof that the model becomes
wrong on day 91. Conversely, a poor but structurally valid no-change judgment can
pass; that is the irreducible judgment boundary and is made visible rather than
silently delegated to code.

---

## 3. Level-of-abstraction fit

The change extends the existing standards-coverage script and existing scheduled
issue instead of inventing a parallel taxonomy service or runtime controller.
Per-family byte review and family-model adequacy remain separate evidence kinds
because they answer different questions and must not substitute for one another.
The shared convergence validator owns the review-process proof; the coverage
script only binds that proof to the exact family set and declared dispositions.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle semantic detector holds blocking authority.

CI authority is limited to closed, enumerable facts: exact keys, allowed enums,
canonical timestamps, jailed regular-file references, hashes, earned convergence,
ledger count agreement, and exact family-set equality. The fallible question —
whether an area should actually be kept, added, split, merged, or retired — is
not scored or selected by the checker. Review age remains a signal consumed by
the existing advisory issue lifecycle.

---

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. Structural
evidence validity is an enumerable invariant. Area-model adequacy is explicitly a
judgment point, and the mechanism preserves it as reviewer authority rather than
encoding proxy rules such as family size or keyword counts.

---

## 5. Interactions

- **Shadowing:** model errors are additive to aggregate coverage, per-family
  floors, content freshness, dangling references, unknown headings, and false
  claims; none suppresses reporting of another.
- **Double-fire:** the same marker-owned cadence issue carries both content and
  model due states, so simultaneous due dates update one issue rather than open
  competing notices.
- **Races:** normal report/check modes are read-only. Record mode writes the
  single model record through a unique temporary file and atomic rename.
- **Feedback loops:** the due issue never changes registry or evidence state and
  therefore cannot make its own condition green.
- **Evidence separation:** a content-review artifact fails the model schema, so
  existing family audits cannot accidentally satisfy the new obligation.

---

## 6. External surfaces

GitHub Actions gains additional summary and issue text inside the existing
weekly standards cadence. No new issue class, API, credential, user message,
dashboard action, runtime configuration, database, or agent-home state is added.
The model record and evidence are committed repository data. There are no
operator-facing actions; the review is performed through the normal repository
change surface.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

**Replicated through Git.** The checker, family list, convergence report,
evidence, and canonical record ship in one commit. Every machine on the same
commit derives the same family-set and byte hashes. The scheduled notice is
repository-scoped GitHub state and already has one marker-owned voice. The
change emits no user-facing notices, holds no topic-scoped durable state, and
generates no URLs.

---

## 8. Rollback cost

Rollback is one repository revert: remove the script/workflow/test changes and
the model record/evidence/report. Older code ignores the new JSON files, so no
data migration or agent state repair is needed. If the cadence issue is open,
the older workflow will update or close it according to content-review state.
There is no runtime propagation window because no shipped runtime code changes.

---

## Conclusion

The review preserves the decisive boundary: structure makes area-model review
unforgettable and non-substitutable, while semantic taxonomy remains a converged
human/agent judgment. The change is isolated to repository governance, composes
with the prior area ratchet, has a clean Git rollback, and is clear to ship after
the focused and repository-wide checks remain green.

---

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** not required

No runtime controller or block/allow path over messages, sessions, dispatch,
coherence, trust, or recovery changes. The only veto is closed repository
evidence integrity, and semantic choices remain outside deterministic authority.

---

## Evidence pointers

- `docs/audits/standards-area-model-adequacy.md`
- `docs/audits/standards-area-model-audit-2026-08-01.json`
- `docs/standards-registry-area-model-audit.json`
- `tests/unit/standards-coverage-ratchet.test.ts`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence:
{enforcementType: ratchet, citation:
tests/unit/standards-coverage-ratchet.test.ts, howCaught: removing the area-model
record fails the live check, and presenting content-only evidence to the model
record path is rejected, so exact family-content proof can no longer masquerade
as proof that the area model itself was reconsidered}`.
