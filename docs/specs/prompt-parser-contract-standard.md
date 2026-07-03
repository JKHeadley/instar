---
title: "Prompt↔Parser Contract Standard"
slug: "prompt-parser-contract-standard"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "prompt-parser-contract-standard.eli16.md"
status: "review-convergence (round-5 clean (codex VERIFIED CLEAN ×2 rounds on the closure; gemini VERIFIED CLEAN r4; internal consistency sweep clean))"
tags: ["review-convergence"]
origin: "INSTAR-Bench v2 defect-class review (docs/audits/ib2-defect-class-review-2026-07-02.md), Class 1"
operator-gate: "Registry/constitution text ships ONLY with Justin's explicit sign-off (Constitutional Traceability). The CI ratchet build ships through the normal instar-dev pipeline."
---

# Spec — Prompt↔Parser Contract Standard (defect class 1 closure)

**Ships:** standard text → standards registry (operator-gated); enforcement ratchet → CI
(additive, shrink-only pending set, no runtime behavior change).

**Run boundary (Autonomy Principle 2):** the /instar-dev run's deliverable is the live
enforcement arm (manifests + contract tests + ratchet) plus the DRAFTED registry text.
Operator sign-off on the registry text is the run's endpoint, not a mid-run pause.

## Problem statement

An LLM callsite whose output is machine-parsed is one contract with two halves maintained
separately: the PROMPT promises an output vocabulary/shape; the PARSER accepts one. Nothing
holds them coherent. INSTAR-Bench v2 proved the failure mode at scale: the tone gate's prompt
taught models the short rule id ("B15") while its production parser accepts only full
identifiers ("B15_CONTEXT_DEATH_STOP") and fails closed on the short form. Every model through
every door obeyed the prompt and "failed" — a 100%-our-fault defect that a single CI test
would have made unrepresentable.

Standards-registry check (verified against `docs/STANDARDS-REGISTRY.md`, 2026-07-02): the
closest standard is **Scrape/Parser Fixture Realness**, which governs the parser's INPUT side
(prove the parser on real bytes). The prompt side of the contract — the output shape the
prompt promises — is governed by no standard. This spec closes that gap.

**Terms (external readability):** *door* = the access path to a model (CLI wrapper vs clean
API); *route* = model + door; *ratchet* = a CI test pinning a baseline that may only
shrink; *callsite* = one LLM decision-point in the coverage registry. (Same glossary block
as the sibling specs.)

## Proposed design

### 1. The standard (registry text, operator-gated)

New registry entry, working title **"The Prompt and the Parser Are One Contract"**:

> Every LLM callsite whose output is machine-parsed must have a CI contract test that renders
> the REAL production prompt, enumerates the output vocabulary AND response envelope that
> prompt promises, and asserts the REAL production parser accepts every promised form — and
> fail-closes on non-promised forms outside its documented alias policy. Wherever the output
> vocabulary is enumerable, prompt, parser, and test must consume ONE exported source of
> truth; a hand-maintained duplicate of the vocabulary is itself contract drift.
> A prompt and its parser may only change together.
> Earned from: the tone-gate B15 short-form defect (INSTAR-Bench v2, 2026-07-02) — every model
> through every door obeyed a prompt whose own parser rejected what it taught.

### 2. Single-source vocabulary (primary form) and the contract manifest (fallback form)

**Primary — generated contract.** For enumerated-verdict callsites (gates, classifiers,
judges with a closed verdict set), the vocabulary lives in ONE exported constant — **the
constant is authoritative, and it is the VERDICT vocabulary, never the parser's tolerant
accepted set** (deriving the taught set from a permissive parser would teach accidental
permissiveness). The prompt builder interpolates its taught token list FROM that constant;
the parser's acceptance is membership in constant ∪ documented aliases BY IMPORT; and the
contract test asserts **set-equality** between the parser's exported accepted set and
constant ∪ aliases — a parser quietly accepting a hidden superset (legacy alias, plantable
verdict token) is red CI, not a latent door. A taught-but-undeclared token is then
*structurally impossible*, not merely tested-against — this closes the manifest-gaming hole
where a minimal declared subset passes review while the prompt teaches more. (Reviewers:
this is deliberately the schema/enum single-sourcing pattern rather than a bespoke parallel
artifact; for envelopes, a schema validator (zod-family) is preferred over hand regex; a
`promptContract` object is the FALLBACK, not the preferred path.)

**Form election is not self-certified:** each contract entry records
`form: 'single-source' | 'manifest'`; a `manifest`-form entry on an enumerated-verdict
callsite requires an X1 argued reason (registry entry, `reason` + `owner`) — "impractical"
is a reviewed claim, not an author's private call.

**Fallback — co-located manifest.** Where the prompt is prose-shaped and single-sourcing is
impractical, the callsite co-locates a machine-readable promise with its prompt builder:

```ts
import { parseToneGateVerdict } from './toneGateParser';

export const promptContract = {
  // every terminal token/shape the prompt text tells the model to produce
  promisedOutputs: TONE_GATE_RULE_IDS,            // prefer the shared constant even here
  // canonical counter-examples the parser must REJECT (fail-closed proof).
  // MECHANICALLY DERIVED from promisedOutputs (case-mutation, prefix-truncation,
  // separator-stripping) plus hand-picked extras — a hand-only list invites trivial rejects.
  rejectedForms: deriveRejectedForms(TONE_GATE_RULE_IDS, ['B15', '']),
  // known-hazard shapes that must NOT appear ANYWHERE in the full rendered prompt
  // (outside explicitly-declared negative sections — see §3.1; never scoped to the
  // self-declared instruction surface)
  // (the inverse-direction backstop, e.g. bare rule ids the parser rejects)
  hazardPatterns: [/\bB\d+\b(?!_)/],
  // the response envelope the prompt promises (JSON shape, field names, quoting rules)
  envelope: { shape: 'json', verdictField: 'rule' },
  // alias policy: compatibility forms the parser deliberately accepts (documented, tested)
  acceptedAliases: [],
  parser: parseToneGateVerdict,   // FUNCTION REFERENCE, not a string — refactor-safe
} as const;
```

Co-location is the point: a prompt edit lands in the same file/diff as the promise, so review
and CI see contract drift as one change.

### 3. The contract test (per callsite)

A unit test per callsite that:
1. Renders the real production prompt via the real builder — **through an exported pure
   render function taking injected config, with synthetic defaults** (no live config, no
   secrets, no I/O in CI) — and asserts every promised token appears in the rendered
   instruction surface AND no `hazardPatterns` match appears outside the promised set.
   **"Instruction surface" is a declared section, not the raw string:** the render function
   exposes section boundaries (at minimum the positive output-instruction section), and the
   POSITIVE token assertions ("every promised token appears") run against that section — so a
   token appearing in a counter-example, comment, or "do not output X" phrasing cannot
   satisfy the test.
   **The NEGATIVE hazard scan is NOT scoped to the declared surface** (round-3 material
   finding): `hazardPatterns` runs over the FULL rendered prompt MINUS explicitly-declared
   negative sections (counter-example / "do not output" blocks, each declared with a stated
   reason). Scoping the hazard scan to a self-declared instruction surface would be
   self-certification — a builder could teach a rejected vocabulary outside its declared
   section and pass CI (the historical B15 shape: short ids taught in the rule-list section,
   not the output-instruction sentence). Undeclared content is therefore hazard-scanned by
   default; a declared negative section is the reviewed exception, never the other way round.
2. Feeds each promised token, wrapped in the callsite's real response **envelope**, to the
   REAL parser (via the manifest's function reference) and asserts acceptance — and the same
   for each documented `acceptedAliases` entry.
3. Feeds each derived + hand-picked `rejectedForms` entry and asserts the parser's documented
   fail-closed behavior. The fail-closed boundary is the manifest's declared
   normalization/alias policy — "non-promised" means outside promised ∪ aliases, so a
   tolerant parser's deliberate compatibility forms are tested as accepted, not flagged.

**Named cost honestly:** the CI runtime of these tests is negligible (pure string assembly +
parser calls, no LLM). The dominant build cost is the render-refactor — several production
builders are private instance methods with live deps (e.g. `MessagingToneGate`'s prompt
builder) and need an exported pure render function. That refactor, across the in-scope
callsites, IS the work of this spec.

### 4. The ratchet (coverage enforcement)

This spec does NOT mint its own registry. It extends the existing bench-coverage record
(`src/data/llmBenchCoverage.ts` — note: `src/data/`, not `src/core/`; the ratchet commits
landed via PRs #1321/#1329 on canonical main) with a `contract` field on the ONE shared
per-callsite metadata record used by the whole defect-class program (see the consolidated
schema in `class-closure-gate.md` §"Program-shared machinery"): a callsite with machine-parsed
output either names its contract-test file or carries an argued exemption per the program's
exemption shape (registry entry with `reason` + `owner`, landed via normal PR review — never
free prose). **Discovery criterion:** the in-scope set is seeded from the coverage registry
(every entry whose provider call parses output) and held complete by the same lint family
that enforces LLM-attribution tags — a new `attribution.component` callsite without a
coverage entry is already red; a coverage entry with parsed output and no `contract`/exemption
field becomes red with this spec. Same graduation mechanics as wave-2/wave-3: the pending set
is pinned in-test and can only shrink. New parsed-output callsites conform from birth
(grandfathering covers only the seeded pending set — a one-line registry edit reverses any
mistaken grandfather).

## Decision points touched

No runtime gate, route, or block changes. Two runtime-adjacent notes for honesty: (a) the
single Frontloaded-Decision #3 runtime contract-drift warning is signal-only (never blocks a
call) and is **deduped once per process per config-hash** — a permanently drifted config
logs once, not per message on hot routes; (b) everything else is CI-only. The ratchet adds a
build-time refusal (new parsed callsite without contract = red CI), in the same family as
the live llm-attribution ratchet, riding the vitest unit suite in `ci.yml` + the husky
pre-push hook (the established ratchet vehicle). **Discovery dependency, stated:** the
in-scope set inherits the attribution/coverage lint's completeness — a parsed-output
callsite missing from the coverage registry is that lint's defect to catch, and this
standard's blind spot until it does; the dependency is named in the registry text.

## Frontloaded Decisions

1. **Inverse-direction check** (was Open Q1): resolved — mandatory `hazardPatterns` on
   fallback manifests (asserted against the rendered prompt), and the primary single-source
   form makes the inverse direction structurally moot for enumerated-verdict callsites.
   Human prompt review additionally checks for ambiguous vocabulary instructions (recorded as
   review guidance in the standard text, not a mechanical check).
2. **Manifest location** (was Open Q2): co-located export (or single-source constant), with
   the coverage-registry `contract` field as the central index in `src/data/`. No separate
   contracts registry file.
3. **Dynamic prompts** (was Open Q3): the contract test renders with synthetic
   production-default config, plus one render per supported config variant that CHANGES the
   vocabulary or envelope (a variant that cannot be covered carries an X1 argued exemption
   naming why). Because config-assembled vocabulary is external-state parsing (Lesson L5:
   drift needs a canary, not a hope), single-sourced callsites ALSO get a cheap runtime
   assertion at prompt-build time: if live config yields a taught vocabulary outside the
   shared constant, the callsite logs a loud contract-drift warning (signal-only — never
   blocks; deduped once per process per config-hash). By-construction single-sourcing is the
   preferred answer: config that references the exported vocabulary cannot drift at all.
4. **Exemption shape** (program-wide X1): an exemption is a registry entry with `reason` +
   `owner`, landed via normal PR review. Free-text prose outside the registry is not an
   exemption.
5. **Immediate CI refusal for new callsites** (contested cheap tag — cleared): shrink-only
   pending set grandfathers existing callsites; only genuinely-new parsed callsites fail,
   and a registry edit is the one-line reversal. CI-only; nothing in the non-cheap taxonomy.

## Rollout

0. Export the shared vocabulary constants / pure render functions for the 4 highest-stakes
   parsed callsites (tone gate, external-op gate, stop judge, input classifier — the
   shipped-fix set). This is also the prompt-fidelity foundation the A/B protocol needs
   (see `authority-clause-standard.md` rollout — the bench template is diffed against this
   same render output before any A/B verdict counts).
1. Contract tests + `contract` field entries for those 4; ratchet lands with the seeded
   pending set (report-only inventory happens by construction — the pending set IS the
   report).
2. Remaining parsed callsites graduate on the shrink-only schedule.
3. Registry text ships last, with operator sign-off, citing the live ratchet as its
   enforcement arm (a standard should point at a guard that already exists — per the
   Standards Enforcement Coverage audit's `ratchet > gate > lint > spec-only` hierarchy).

## Open questions

*(none — all resolved into Frontloaded Decisions above)*
