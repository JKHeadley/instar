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
