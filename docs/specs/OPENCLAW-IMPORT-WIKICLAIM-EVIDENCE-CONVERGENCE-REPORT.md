# WikiClaim Evidence Import — Convergence Report

**Spec**: `OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md`
**Status before review**: Draft
**Status after review**: Review-Convergence
**Convergence date**: 2026-05-07
**Rounds run**: 2
**Reviewer mix**: 4 internal angles (security, scalability, adversarial, integration) + 3 substitute Claude-internal external reviewers (supply-chain, data-modeling, developer-experience). External-model APIs (GPT/Gemini/Grok) were not available in this worktree, so substitutes were used and this report flags single-reviewer findings as such.

---

## ELI16 Executive Summary

The spec adds "receipts" to memory entities. Today, each thing Echo remembers has a one-line `source` like `"session:abc"` or `"user:Justin"`. With this change, every memory also carries a typed list of receipts: which feedback report, which commit line, which conversation message taught it. This makes it possible to ask "why did Echo decide this?" and get a real answer with citations.

Round 1 of review found four serious problems and eleven medium problems. Two examples of the serious ones:

1. The original spec said "JSONL backup includes evidence inline." But evidence gets added *after* the entity is created, so the original JSONL "remember" line wouldn't include the later evidence. Replaying the JSONL after a disaster would silently lose evidence. The fix: separate `addEvidence` JSONL lines so the backup can be replayed faithfully.

2. The spec assumed three subsystems (FeedbackManager, EvolutionManager, DecisionJournal) already create memory entities, so it just needed to "add evidence." Verification against the actual Instar source showed those subsystems write to their own files and *don't* touch the memory store at all today. The fix: be explicit that this work includes a *bridge* from each subsystem into the memory store, not just an evidence add.

After Round 1 amendments, Round 2 found no new serious problems. The spec is ready for `/instar-dev`.

---

## Per-Round Findings

### Round 1

| Reviewer | Severity counts | Highlights |
|---|---|---|
| Security | 1 blocker, 2 majors, 2 minors | `note` field PII risk; missing per-caller kind allowlist enforcement; inverse query leaks link structure |
| Scalability | 0 blockers, 2 majors, 1 minor | JSONL replay loses evidence (BLOCKER-equivalent in adversarial review); index insert cost flagged |
| Adversarial | 1 blocker, 2 majors, 1 minor | Supersedes-evidence cycles → infinite loop; producer-crash partial-write; dead-session backfill |
| Integration | 2 blockers, 2 majors, 1 minor | FeedbackManager/DecisionJournal/EvolutionManager don't create entities today — bridge required, not modification |
| Supply-chain (sub) | 0 blockers, 2 majors, 1 minor | `PRAGMA foreign_keys` not on by default in better-sqlite3; transaction scope unspecified |
| Data-modeling (sub) | 0 blockers, 2 majors, 2 minors | `lines` freeform unparseable; `pattern-entity` referenced in producers but not in enum |
| DX (sub) | 0 blockers, 2 majors, 2 minors | `findEntitiesByEvidence` reads worse than `findCitations`; addEvidence single-form encourages N round-trips |

**Round 1 totals**: 4 blockers, 14 majors, 10 minors.

### Round 2 (post-amendment)

All four blockers cleared. All majors either addressed in spec amendment or explicitly deferred in the new "Review Decisions" section with rationale. Two minors deferred to implementation phase (rate-limit calibration, replay-after-forget edge case).

**Round 2 totals**: 0 blockers, 0 majors, 2 carry-forward minors.

---

## Final State

| Severity | Open after convergence |
|---|---|
| Blockers | 0 |
| Majors | 0 |
| Minors | 2 (both deferred to Phase 1 implementation, not design-level) |

Open minors:

1. **Rate-limit calibration**: spec specifies "10 evidence/sec/producer default" — value is a guess, needs Phase 1 benchmark before lock-in.
2. **JSONL replay edge case**: replaying `addEvidence` after a `forget` of the same `entityId` should be a no-op; spec implies but doesn't state. Implementation detail.

---

## Cross-Model Agreement vs Single-Reviewer Findings

External-model APIs (GPT/Gemini/Grok) were NOT available in this worktree. Substitute Claude-internal reviewers were used for supply-chain, data-modeling, and DX. This means findings that *would* require independent-model perspective (concurrency, supply-chain attacks via npm advisory, parallel-correctness) are NOT robustly covered.

**Findings with multi-reviewer agreement (high confidence):**

- Producer integration is a bridge, not a modification (Integration + DX agreement).
- Supersedes-evidence cycle risk (Adversarial + Data-modeling agreement on enum hygiene).
- Inverse-query privacy filter required (Security + DX agreement on `findCitations` rename + scope filter).
- JSONL replay needs separate evidence actions (Scalability + Supply-chain agreement on transaction + replay semantics).

**Single-reviewer findings (lower confidence; verify in Phase 1):**

- Renderer SSRF via `external-url` (Security only). Mitigation is conservative — render `path` as display-only — but no second reviewer corroborated the threat model framing.
- 50-row cap with 500-row hard ceiling (DX only). Calibration is a guess.
- Note byte cap of 500 (Security only). Value is a guess; revisit if real producer use bumps against it.

**Coverage gaps from missing external-model reviewers:**

- Concurrency under multi-process SemanticMemory access (would expect Grok/Gemini to flag). Better-sqlite3 is single-process safe but multi-process needs WAL inspection.
- Supply-chain: better-sqlite3 advisory history, native binding compatibility under multi-arch builds.
- Independent reading of OpenClaw shape: only Echo cross-checked the `markdown.ts:11-101` source. A second reviewer reading OpenClaw fresh might catch shape-parity drift.

Recommend that any Phase 1 PR runs `/crossreview` once external-model access is restored, before merge.

---

## Final Recommendation

**Ready for `/instar-dev`: YES**, with the following caveats:

1. Phase 1 PR MUST include the `PRAGMA foreign_keys = ON` assertion, the cascade-delete integration test, and benchmark numbers for the two new indexes against the existing 10k-entity baseline.
2. Phase 1 PR SHOULD run `/crossreview` (external-model) once access is restored, since this convergence used substitute reviewers for the external slot.
3. Phase 2/3 producer wiring is the highest-risk integration work: each of EvolutionManager, FeedbackManager, DecisionJournal currently writes to its own store and does NOT create MemoryEntity rows. The "bridge" pattern is new code, not a modification.
4. Implementation must preserve the "no LLM in producer path" principle — spec is now clear about this; reviewers agreed.

**Reasoning**: After two review rounds the spec has zero open blockers and zero open majors. The two carry-forward minors are calibration questions answerable only with implementation telemetry. Single-reviewer findings are conservatively mitigated. The Integration reviewer's discovery that producer subsystems don't currently create entities is the most important finding — it converts what looked like a small schema-add into a moderate cross-subsystem integration, which the amended spec now reflects honestly. No further design-level review rounds are warranted; remaining risk is implementation risk.
