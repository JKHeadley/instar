# Side-Effects Review — a failing test whose remediation advice was impossible

**Version / slug:** `builtin-manifest-honest-remediation`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

`tests/unit/builtin-manifest.test.ts` compares the on-disk `src/data/builtin-manifest.json` against a
fresh regeneration. On mismatch it failed with:

> `src/data/builtin-manifest.json is stale — run scripts/generate-builtin-manifest.cjs and commit the result`

That artifact is **gitignored** (`.gitignore:87`) and **absent from git entirely**. "Commit the result"
is not actionable, and the correct action — *rebuild* — was never stated. `scripts/generate-builtin-
manifest.cjs:26` carried the same wrong advice plus a reference to a test name that had since changed.

Changes: corrected the failure message to name the real remedy (rebuild, never commit) and the reason;
corrected the generator's warning; renamed a misleading local (`committed` → `onDisk`); documented the
one genuine limitation; added one assertion pinning the gitignored premise the new advice rests on.

## Refusal evidence (constraint 2)

```
REFUSAL 1 — stale on-disk artifact (the real detection this test provides)
  Set instarVersion to 0.0.1-STALE in the on-disk manifest:
  × the on-disk build artifact is not older than current source
    → "…on disk is STALE relative to current source — REBUILD it … Do NOT try to commit it:
       it is a generated, gitignored artifact (.gitignore:87)…"
  Tests  1 failed | 9 passed (10)

REFUSAL 2 — pretend the artifact became git-tracked
  × REGRESSION: the manifest is a gitignored artifact, never a committed baseline
    → "…is now TRACKED by git. The staleness check above says 'rebuild, do NOT commit', which was
       correct only while this artifact was gitignored…"
  Tests  1 failed | 9 passed (10)
```

Restored: **10 passed (10)**, `tsc --noEmit` exit 0.

## I was wrong about this twice, and the test corrected me

Recorded because the correction is the substance.

**My first analysis was that the check is tautological** — that `beforeAll` generates the file, the
test regenerates it, and the assertion is therefore `generate(src) === generate(src)`, incapable of
failing. I acted on that: I renamed the test to "generates deterministically" and rewrote its message
around non-determinism.

**Running it falsified that immediately.** It went red — not on determinism, but because my own on-disk
artifact was genuinely stale: `instarVersion 1.3.987` on disk against `1.3.990` regenerated, with
differing `contentHash` values. The check was doing precisely the job I had just argued it could not do.
`beforeAll` generates only **when the file is missing**; with a stale artifact present, the comparison
is real.

I reverted the rename and corrected only what was genuinely broken. **The rewrite would have deleted a
working safeguard and replaced it with a weaker one on the strength of an untested argument** — the
same over-claiming shape as the two corrections on the increment before this.

The grain of truth is retained as documentation, not as an action: on a **fresh checkout** the file is
created by `beforeAll`, so the comparison is then trivially satisfied. The check has teeth only when a
prior artifact exists. Green means "no stale local build found", which on clean CI usually means there
was none to find. That is now stated in the test rather than assumed either way.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| on-disk vs regenerated diff | `invariant` | Unchanged behaviour; byte comparison with `generatedAt` normalised. |
| artifact must be untracked | `invariant` | `git ls-files --error-unmatch`, try/catch → boolean. No model. |

No judgment points, no LLM, nothing gated.

## 1. Over-block

Nothing new is blocked; this is a test-only + warning-text change. The added assertion can only fail
if the artifact becomes git-tracked, which is a deliberate repo decision — and if that happens, failing
is correct, because the corrected advice ("never commit") would then be wrong. The message says exactly
that rather than merely going red.

Over-block risk I explicitly did NOT take: my first version would have removed the staleness detection
entirely. Rejected once the test falsified the premise.

## 2. Under-block

**No committed-baseline check is added.** There is nothing committed to compare against, and tracking a
generated artifact to satisfy a test would be the wrong trade. Stated in the test so it is not silently
re-litigated.

**Fresh-checkout blindness remains.** `beforeAll` generating the file makes the comparison vacuous in
that case. Fixing it would mean failing when the artifact is absent, which would break the
self-sufficiency the `beforeAll` exists to provide. Documented, not changed. <!-- tracked: CMT-1044 -->

**The generator's own warning is heuristic** — it fires on any uncommitted `src/` change, which during
active development is nearly always. Unchanged in behaviour; only its text is corrected.

## 3. Level-of-abstraction fit

The correction lives in the two places that speak to a human — the assertion message and the generator
warning. No production code path is touched. The duplicated advice in the generator is what made this
worth fixing in both places at once: correcting only the test would have left the same false instruction
reachable from the other direction.

## 4. Signal vs authority compliance

Pure test/diagnostic text. `docs/signal-vs-authority.md` is satisfied trivially — nothing gates, blocks,
or decides.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced.

## 5. Interactions

- **`package-completeness.test.ts`** — runs a full build that regenerates the same artifact. The
  temp-path generation (from an earlier fix, retained) keeps this check read-only and race-free.
- **`prepublishOnly`** — regenerates the manifest before publish; unaffected.
- **`.gitignore:87`** — the premise the new assertion pins. If it changes, the assertion fails loudly.

## 6. External surfaces

None. No route, no config, no persisted state, no user-visible behaviour. Test assertion text and one
CLI warning.

## 6b. Operator-surface quality

The failure now names the action (`npm run build`, or the generator directly), names why committing is
wrong, and adds the one honest ambiguity: if it is red in CI rather than locally, suspect generator
non-determinism instead. That last clause is the residue of my wrong first analysis, kept because it is
a real alternative explanation.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by nature — the artifact is a per-checkout build output. No replication, no lease, no
generated URL. A stale artifact on one machine says nothing about another, which is exactly why the
remedy is "rebuild here".

## 8. Rollback cost

Trivial. One test file, one warning block in a script, two docs. No persisted state, no migration.

## Phase 5 — Second-pass review

Not a gate, sentinel, guard or watchdog; no block/allow authority; no session lifecycle or trust
surface. High-risk trigger list not engaged. Author lenses:

**Adversarial — "how would I make this useless?"** Two ways, both now asserted: let a stale artifact
pass (refusal 1), or let the gitignored premise silently flip (refusal 2).

**"Would it have caught the incident?"** The incident is mine: I hit the real failure, misread it as
tautology, and nearly deleted the check. The corrected message states the actual remedy in the first
clause, which is what I needed and did not have.

**"Symptom or cause?"** Cause, for the misleading-advice defect — the wrong instruction existed in two
places and both are corrected. Symptom-level for fresh-checkout blindness, which is named and left.

**Weakest point:** the value here is entirely in wording, and wording is the easiest thing to regress.
The gitignored assertion guards the premise but not the phrasing; nothing stops someone reintroducing
"commit the result" tomorrow.
