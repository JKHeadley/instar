# Side-effects review — spec contract generator

**Change:** adds `scripts/generate-spec-contract.mjs`, a build-time generator that
produces `docs/specs/generated/<slug>.contract.md` from a spec: the normative
sections only, with review history and inline round-annotations stripped.

**Tier:** 1 (declared). New standalone dev-tooling script; no runtime surface, no
`src/` change, no decision point. Signal-only in the strongest sense — it emits a
derived document and can refuse a stale check; it gates no agent behavior.

**Why it exists:** on the `outbound-gate-advisory-override` spec, both external
reviewers (codex-cli, gemini-cli) independently identified the same risk across
several rounds — a spec that honestly records 33 rounds of review accumulates
change logs describing designs that were later **reversed**, and an implementer
reading top-to-bottom can follow a retired design. Both proposed the same fix:
publish the contract separately from the history.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

The generator's only refusal is `--check` failing when the committed contract does
not byte-match a fresh generation. That is the intended behavior (CI staleness
gate), and it is refusable-by-regeneration, not by argument.

**Real over-block risk identified:** the history-heading regex could classify a
*normative* section as history if someone titles one `## Round-trip validation` or
similar. Mitigated by requiring both a `Round-N` prefix **and** one of
`change log` / `hand-check` / `consistency sweep`, plus an `ALWAYS_CONTRACT_RE`
allowlist for the known normative section names. A false positive drops a section
from the generated contract — visible immediately as a missing section, not
silent.

## 2. Under-block — what does it still miss?

**Found in practice, not in review:** the first version recognised only per-round
`## Round-N … change log` headings. Pointed at a second spec that consolidates its
history into a single `## Review record` section, it matched nothing, stripped
nothing, reported `0 history sections excluded` and **exited 0**. A silent no-op
that presents as success — the same species as a check that cannot run.

Widened by one alternative (`Review record`). The residual is unchanged and now
explicit: the pattern is a closed list of heading shapes, so a document using a
convention not on the list is silently unstripped. The mitigation is the output
line itself — it always reports how many sections it excluded, so *reading* it
catches this. The ELI16 now says so directly.


**Found again, worse, by pointing the tool at its own output (round-37, codex).**
The generated contract was reviewed as the build artifact for the first time, and
it was **not contract-only**: blockquote meta-blocks survived, including a
"NON-NORMATIVE FROM HERE" marker sitting inside a file whose banner claimed
review history was "deliberately absent." A boundary marker inside a document
that denies having boundaries is worse than no marker — and the banner was
straightforwardly false.

Two fixes, one mechanical and one honest:

1. **Meta-blockquotes are now stripped** — blocks that talk *about* the document
   (normative-boundary markers, "this file is rationale", scope notices) rather
   than about the design. Counted and reported separately from history sections.
2. **The banner no longer overclaims.** It now states what is removed, what is
   *not* removed, and prints the **count of narrative round-references remaining**
   in the file. The previous wording promised absence it could not deliver, which
   is exactly the class of overclaim the spec under review kept being corrected
   for. A tool that lies in its own header is worse than one with a stated limit.

- **Narrative history inside normative prose.** The generator strips history
  *sections* and *inline annotations*; it cannot strip a paragraph of normative
  prose that happens to narrate how a decision evolved. Those remain in the
  contract. Partially addressed by the spec's own §0.2 "current design overview";
  fully addressing it would require judgment the generator deliberately does not
  have.
- **It does not verify the contract is CORRECT** — only that it is current. A
  spec that is internally contradictory generates a contract that is equally
  contradictory. The separate spec lint (required by the outbound spec) is what
  addresses that; this is not it.

### `--strict` (allowlist mode) — over/under-block

**Over-block risk, and it is real:** an allowlist drops a genuinely normative
section whose heading is not on the list. That is a *silent* omission — the
opposite failure from the denylist's silent retention. Mitigated by the run
reporting `N allowlisted sections kept`: a spec that should yield 10 sections and
reports 2 is visibly wrong, which is exactly how the missing-trailing-period bug
in the heading pattern was caught (§4 "Honest limits" and §5 "Test plan" were
silently dropped until the count was read).

That mitigation is a human reading a number, which is weaker than a check. The
honest position: **`--strict` trades a silent-retention failure for a
silent-omission failure**, and the omission is the one that could cause a missing
requirement rather than a confusing one. It is therefore additive and opt-in —
the default denylist mode and its output path are unchanged, and no build gate
requires strict mode.

**The over-block risk was confirmed within an hour of shipping it.** Pointed at
`outbound-gate-advisory-override`, strict mode kept 8 of 66 sections and dropped
the normative outcome table, whose headings are not on the allowlist. The
reviewer's *first* finding was "normative behavior is missing from the strict
contract" — the exact silent-omission failure predicted above, on the first spec
with a different heading scheme.

**Guard added:** strict mode now computes the kept-section ratio and prints a
`WARNING (strict)` when a spec with >=8 headings matches under 25% of them,
naming the ratio and saying the output may be missing normative sections. It
fires on `outbound-gate-advisory-override` (8/66, 12%) and stays silent on
`inbound-message-recording-gap` (11 sections, 41% capture) — a real signal on the
real failure, no noise on the working case.

The guard is a warning, not a refusal, and deliberately: the ratio is a heuristic,
and a genuinely rationale-heavy spec can legitimately capture low. A refusal on a
heuristic would block correct output; a warning that names the number lets a human
apply the judgment the tool does not have.

### A third failure mode, found by shipping it (2026-07-25)

The capture-ratio warning guards against *too few sections matching*. It does not
see **a matched section that captured nothing** — and that happened live: adding a
`### Normative checklist` heading inside the allowlisted `### 3.0 Final contract`
ended that section's capture, dropping the entire contract table **and the new
checklist** from the output. The section count stayed at 10, so the existing guard
was silent, and the emptied contract would have shipped.

A second guard now compares **captured bytes against source bytes per section**
and warns when a section captures under 25% of a source section over 1 KB.

**Getting it right took three attempts, each verified against the real regression
rather than assumed:**

1. *Average bytes per section* — nine healthy sections masked one empty one.
2. *Absolute per-section threshold* — permanently false-positived on legitimate
   container headings (`## 4. Honest limits` immediately followed by an allowlisted
   `### 4.0 …`). **A guard that always warns is a guard nobody reads.**
3. *Captured vs source, per section* — worked only after the source measurement
   stopped using the capture's own stopping rule, which had made it shrink in
   lockstep with the truncation it was meant to detect.

Verified in both directions each time: fires on the regression, silent on the
correct file, large-spec behaviour unchanged.

### The guard's own false-positive mode (found before merge)

The captured-vs-source guard fired permanently on every **numbered** spec. Cause:
the source measure deliberately does not use the capture's stopping rule (or it
would shrink in lockstep with the truncation it detects), so it ran past the next
*sibling* section and counted that sibling's bytes as "missing".

Both shapes look identical structurally — a same-level heading follows an
allowlisted one:

- `### 3.0 Final contract` → `### Normative checklist` — meant as a **child**;
  its content belongs to 3.0 and losing it is a real defect.
- `### 3.10 Test plan` → `### 3.11 Judgeable-record` — a genuine **sibling**;
  its content was never 3.10's and excluding it is correct.

Separated by a numbered-sibling test. Verified in both directions: silent on the
numbered spec, still warning on the child-heading regression.

**This is the third time this guard needed correcting, and the second time the
failure was "it warns constantly".** That mode is worth naming as its own defect
class: a permanently-firing warning is not a conservative guard, it is a disabled
one, because the reader stops looking.

**Also fixed before merge:** a nonexistent `--spec` path threw a raw Node stack
trace; it now exits 2 with a one-line error.

**Under-block:** unchanged. A rule narrated inside an allowlisted section still
carries its own history; strict mode reduces the surface, it does not clean prose.

## 3. Level-of-abstraction fit

Correct layer: it is a build-time document transform, alongside the other
`scripts/*.mjs` spec tooling (`write-convergence-tag.mjs`,
`eli16-overview-check.mjs`, `publish-spec-review.mjs`). It does not belong in
`src/` — nothing at runtime reads a spec.

**Should a higher layer own it?** `/spec-converge` could invoke it automatically
on convergence. Deliberately not wired that way in this change: the generator
should prove itself as a standalone tool first, and auto-invocation is a change to
the skill's contract, not to this script. Not deferred-and-forgotten — it is
simply not part of this change's scope, and the script is useful without it.

## 4. Signal vs authority compliance

**Compliant, trivially.** The script holds no authority over agent behavior. Its
one enforcement surface (`--check` exiting non-zero) is a build-time staleness
assertion on a *derived artifact*, with a deterministic remedy (regenerate). It
makes no judgment, consults no model, and gates no message, session, or action.

## 5. Interactions

- **Shadows nothing.** No existing script generates or validates a spec contract.
- **Shadowed by nothing.** It reads a spec and writes a derived file under
  `docs/specs/generated/`, a path nothing else writes.
- **No double-fire, no race.** Single-shot CLI; no daemon, no watcher, no
  scheduling.
- **Adjacent tooling unaffected:** `write-convergence-tag.mjs` and
  `eli16-overview-check.mjs` read the *source* spec; this writes only the
  generated copy. `hashSpecReviewableBody` (used for cross-model delta-gating)
  also reads the source, so generated files never affect review gating.

## 6. External surfaces

- **Other agents / users:** none. Dev tooling in the instar repo; not installed to
  agent homes, not referenced by any hook, job, or template.
- **Timing / runtime conditions:** none — pure file in, file out.
- **New file paths introduced:** `docs/specs/generated/`. Additive; no existing
  path changes meaning.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and trivially so:** the script runs in a developer's
checkout and writes a file into that checkout, which is then committed and
distributed by git like any other source file. There is no runtime state, no
per-machine store, no notice, and no generated URL. Running it on two machines
against the same spec produces byte-identical output (the transform is pure and
deterministic — no timestamps, no randomness, no environment reads beyond the
input path).

That determinism is what makes the `--check` mode usable in CI at all, and it is
asserted by the mode's existence: if the transform were machine-sensitive, CI
would fail against a contract generated on a developer's machine.

## 8. Rollback cost

**Near zero.** Delete the script and the generated directory; nothing depends on
either. No release, no migration, no agent-state repair. If the `--check` mode
turns out to be a nuisance in CI, it can be dropped independently of the
generator (the generator is useful without the check; the check is not useful
without the generator).

---

## Verification performed

- Generated against the real 2,700-line spec: 36 history sections excluded, 37%
  smaller output.
- `--check` verified in both directions: passes on a current contract, fails with
  a clear message on a stale one.
- Regex leak found and fixed during verification (`## 24. Round-11 external
  change log` was initially retained because the heading text between `Round-11`
  and `change log` was not matched) — caught by inspecting the generated
  headings rather than trusting the run.

## Second pass

**Not required.** The change touches no block/allow decision, no session
lifecycle, no coherence gate, and nothing named sentinel/guard/gate/watchdog. It
is a standalone document transform.
