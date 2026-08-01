# Side-Effects Review — Standards Enforcement Heading Scope

**Version / slug:** `standards-enforcement-heading-scope`
**Date:** `2026-07-31`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Hume`

## Summary of the change

This change makes standards enforcement classification follow the registry's actual
article structure. `StandardsRegistryParser.ts` captures complete multiline fields and
admits guard references only from an explicit enforcement-heading enum;
`StandardEnforcementExtractor.ts` consumes those sections;
`StandardsEnforcementAuditor.ts` exposes parse-scope diagnostics; and the self-contained
CI parser in `scripts/standards-coverage.mjs` mirrors the runtime behavior with an exact
parity test. Known provenance and narrative headings remain excluded, while a genuinely
unknown heading is visible and rejected by both the runtime canary and CI ratchet.

## Build context

- **Canonical remote:** `https://github.com/JKHeadley/instar.git`
- **Isolated worktree:** `.worktrees/agent-standards-enforcement-heading-scope`
- **Branch:** `agent/standards-enforcement-heading-scope`
- **Base:** `7e677149b` (`v1.3.1096`)
- **Rollback unit:** one source commit plus its release fragment; no state migration

## Decision-point inventory

- `StandardsRegistryParser.parse()` heading classification — **modify** — deterministically
  classifies each bold registry heading as enforcement, provenance, narrative, or unknown.
- `StandardEnforcementExtractor.extract()` evidence discovery — **modify** — scans complete
  allowlisted enforcement sections in addition to the legacy `Applied through` field.
- `StandardsEnforcementAuditor.audit()` runtime canary — **modify** — reports unclassified
  headings and treats their presence as an untrustworthy audit input.
- `scripts/standards-coverage.mjs --check` — **modify** — refuses unknown headings, keeps
  dangling references at a zero ceiling, and raises the measured enforcement floor from
  0.64 to 0.70.

---

## 1. Over-block

The new zero-unknown rule will reject a legitimate new registry heading until that
heading is explicitly assigned to enforcement, provenance, or narrative scope. For
example, adding `**Verification hooks.**` to an article without updating the parser enum
will fail the runtime canary and CI. That is intentional: the parser cannot silently
guess whether paths in a new section are guards. Exact spelling, punctuation, and case
are part of the structured registry contract, and the failure includes the article and
heading so the enum can be updated deliberately.

The 0.70 coverage floor leaves 0.0073 measured headroom. One additional unguarded
standard would reduce the ratio to 58/83 = 0.6988 and fail. This is the intended ratchet
behavior, not a general runtime block; it prevents the registry from adding an
enforcement claim without naming a real guard.

---

## 2. Under-block

An allowlisted enforcement section can still make an inaccurate semantic claim about
what a real path enforces. The existing claim-verification pass detects some such
overclaims but remains deliberately conservative. A referenced test that is skipped or
weak still resolves as a live artifact; this change verifies citation existence and
classification provenance, not test quality. The pre-existing Cross-Store Coherence
false-claim finding therefore remains visible rather than being hidden by this parser
change.

A future author can also place prose in an allowlisted section with no paths. That does
not create enforcement evidence: the extractor still requires a resolvable guard
reference, so the article stays documented-only.

---

## 3. Level-of-abstraction fit

Heading classification belongs in `StandardsRegistryParser`, which owns the registry
grammar. Guard-reference recognition remains in `StandardEnforcementExtractor`, and
artifact existence/classification remains in `StandardsEnforcementAuditor`. This keeps
the parser from deciding whether a cited file is a real guard.

The CI script must remain self-contained because it runs before the TypeScript build is
available. Re-implementing the small parser there is therefore necessary, but an exact
classification-parity test compares its complete article map with the library parser so
the two implementations cannot drift silently.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Deterministic hard-invariant authority — the input domain is an explicitly enumerated structured registry grammar, not natural-language intent.
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

This is a constrained exception described by the principle itself. The check validates
the classification of authored Markdown field labels; it does not infer what arbitrary
prose means or decide a user action. Every current label is enumerated, and an unknown
label has no safe implicit interpretation because treating provenance as enforcement
creates false confidence while ignoring enforcement creates a false gap. The runtime
parser emits the structured unknown-heading signal; the standards audit canary and CI
policy are the single authorities for their respective decision points and log the
article/heading evidence behind the failure.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. Heading
membership is a closed grammar invariant: there are no live signals such as liveness,
urgency, ownership, or recency to arbitrate. The system refuses an unknown grammar token
until an author explicitly classifies it rather than making a contextual judgment from
the section body.

---

## 5. Interactions

- **Shadowing:** parser scope runs before reference extraction by design. Provenance,
  narrative, and unknown sections never reach path extraction; tests plant guard-shaped
  paths in those sections and prove they remain excluded.
- **Double-fire:** the runtime canary and CI ratchet can both report the same unknown
  heading. They act in different environments and share no mutable state; duplicate
  detection is useful defense in depth and produces no duplicate external action.
- **Races:** parsing is synchronous and derived only from immutable file contents. There
  is no shared state, retry, cleanup, or lifecycle race.
- **Feedback loops:** registry/source hashes invalidate cached audit reports after a
  change, but reports never modify the registry. The coverage result cannot feed itself.
- **Existing checks:** the zero-dangling ceiling and false-claim detector remain active.
  The corrected No Manual Work citation removes the one newly exposed stale alias
  without weakening the dangling-reference ratchet.

---

## 6. External surfaces

The owner-gated standards coverage response gains additive
`registry.enforcementScope` diagnostics and several standards move from
documented-only to their evidence-backed classifications. The measured registry is now
82 articles, 17 documented-only gaps, and an enforced ratio of 0.7073. Existing route
names, filters, legacy `appliedThrough`, and `enforcementBasis` semantics remain
compatible. The CI floor changes from 0.64 to 0.70 and unknown headings gain a zero
ceiling.

There are no new external calls, credentials, write endpoints, persistent records,
notifications, URLs, or operator-facing actions. No Telegram, GitHub, Cloudflare, or
other integration behavior changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated through source control:** every machine running the same code and registry
bytes derives the same heading scope, guard references, classifications, and coverage
ratio. No separate runtime replication mechanism is needed because the feature has no
mutable state. It emits no user-facing notices, holds no durable state that could strand
on topic transfer, and generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the parser, extractor, auditor, and CI changes and ship the
  next patch. The independently correct registry citation may remain.
- **Data migration:** none; all output is derived from source files.
- **Agent state repair:** none; cached reports invalidate from source hashes.
- **User visibility:** the additive diagnostics and corrected classifications disappear
  while rollback propagates, but no user data or workflow state is lost.

---

## Conclusion

The review tightened the initial design from a broad “report excluded headings” model
to a four-way closed grammar: enforcement, provenance, narrative, or unknown. Unknown
headings now fail visibly instead of silently entering the documented-only bucket, and
provenance paths can never masquerade as guards. Focused parser/extractor/auditor tests,
the exact CI/runtime parity test, the live registry ratchet, lint, and build are green.
The independent second pass concurred; the change is clear to ship.

---

## Second-pass review (required)

**Reviewer:** Hume
**Independent read of the artifact:** concur

The closed heading grammar correctly admits only enforcement sections, excludes both
`Earned from` and `Traces to the goal`, rejects unknown headings as a deterministic
structural invariant, preserves runtime/CI parity and additive API compatibility, fixes
the stale No Manual Work citation, and has a clean code-only rollback. The reviewer
independently confirmed the live ratchet/build and 76 focused tests pass.

---

## Evidence pointers

- `tests/unit/standards-registry-applied-through.test.ts`
- `tests/unit/standard-enforcement-extractor.test.ts`
- `tests/unit/standards-conformance-gate.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`
- `tests/e2e/standards-coverage-lifecycle.test.ts`
- `node scripts/standards-coverage.mjs --check`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The primary defect is a product
parser bug over the standards registry; `prompt-parser-contract-drift` explicitly
excludes genuine parser bugs in non-prompt code. The incidental stale citation was
corrected, while the zero-dangling ratchet already guards that artifact class.
