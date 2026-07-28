# Side-effects review — benchmark-source-match

**Change:** correct the two `benchedPromptSource` values in
`src/data/benchmarkPredictions.json` (`:` → `#`) so they match the
`PROMPT_TEMPLATE_REGISTRY` sources the analyzer compares them against, and add a
CI ratchet that makes the mismatch unshippable.

**Tier:** 1 (ELI16 + side-effects; a data correction plus a test — no new
runtime code path).

---

## The defect in one paragraph

`BenchmarkDivergenceAnalyzer.ts:423` computes
`registrySourceMatches = task.benchedPromptSource === registryEntry.source`.
The mirror wrote `src/core/MessagingToneGate.ts:TONE_GATE_PROMPT_TEMPLATE`; the
registry declares `src/core/MessagingToneGate.ts#TONE_GATE_PROMPT_TEMPLATE`. So
the flag was `false` for every task on every run, step 2 of the verdict ladder
fired, and the Benchmark-Divergence Detector returned
`precondition-failed / hash-unverifiable` for its entire shipped life. It has
never produced a single actionable verdict. Verified directly against the live
constants before changing anything.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**At build time: one new way to fail, deliberately.** A mirror whose
`benchedPromptSource` or `benchedPromptHash` disagrees with the registry now
fails CI. That is the entire point, and both failure messages say exactly what to
do (`the registry uses '#', not ':'` / `re-capture the mirror; do NOT edit the
hash by hand`).

**At runtime: nothing.** This *unblocks* — it removes a precondition failure that
was firing on every comparison. No input that previously produced a verdict now
produces a different one; inputs that produced `precondition-failed` may now
produce a real verdict, which is the intent.

## 2. Under-block — what failure modes does this still miss?

- **The detector may now say very little for a while.** Getting past the
  precondition does not manufacture evidence: most comparisons will land on
  `insufficient-evidence` until enough graded decisions accumulate. Correct
  behaviour, and worth stating so "it's still not saying much" isn't read as
  this fix having failed.
- **The mirror's per-model baselines are still whatever was last captured.** This
  change does not re-capture them, and deliberately does not invent numbers for
  models that were never benchmarked (see §6).
- **Other silent-precondition classes remain possible.** `stale-mirror` and
  `prompt-drifted` are real, legitimate states. The new hash test converts one of
  them (drift) into a loud build failure, but a mirror that ages past its
  staleness bound will still quietly suppress verdicts — the same shape of
  problem, one layer out. Not fixed here; named honestly.

## 3. Level-of-abstraction fit

The fix is at the data layer because the data was wrong: the registry is
documented as authoritative (`benchedPromptSource must match this string or Q0
is hash-unverifiable`), so the mirror is what needed correcting.

The *guard* is at the build layer, which is the right place for an invariant
between two static files. It could not sensibly live at runtime — at runtime the
mismatch is already indistinguishable from a legitimately stale benchmark, which
is precisely why it survived.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. Unchanged, and deliberately so.

The exact-match comparison in the analyzer is a **brittle check with real
authority** — it suppresses verdicts. That is the documented exemption class: a
false pass (comparing against a benchmark that does not describe the live
prompt) produces confident wrong claims about a model, while a false block
produces silence. Silence is the safe direction.

**I explicitly rejected the tempting fix.** Normalising the comparison so `:` and
`#` both match would have made the symptom disappear while weakening the guard —
trading a visible failure for a silent one, and letting genuine
benchmark/prompt mismatches through. The strict comparison stays; the mismatch
becomes unshippable instead.

The new test holds no runtime authority: it is a build-time assertion over two
static files.

## 5. Interactions

- **The verdict ladder** — untouched. The change moves inputs past step 2; steps
  3–9 behave exactly as before. Both branches are pinned by the new behavioural
  tests (same evidence, `registrySourceMatches` false vs true →
  `precondition-failed` vs `aligned`).
- **`benchmarkDivergence.dryRun`** — orthogonal. This is why the detector never
  *persisted* findings; the source mismatch is why it never *had* one worth
  persisting. Fixing one without the other leaves the feature dark, and the
  dryRun flip is the operator's, not this PR's.
- **The tone-gate prompt** — I suspected my own 2026-07-25 tone-gate change had
  drifted the prompt hash and caused this. It had not: both hashes match live.
  The new hash test now makes that class of drift a build failure rather than a
  silent suppression, so a future prompt edit cannot repeat the worry.
- **No shadowing, no double-fire.** One comparison, one callsite.

## 6. External surfaces

- `GET /benchmark-divergence` — no shape change. `summary.byVerdict` and
  `findings` may become non-empty for the first time; every finding remains
  `advisory: true` and gates nothing.
- No new route, config key, flag, env var, CLI surface, or message.
- **No fabricated data.** The mirror's per-model numbers are untouched. Adding
  `claude-opus-5` / `claude-fable-5` baselines requires actually running the
  benchmark against those models; inventing plausible pass rates would poison
  the exact comparison this change exists to enable. Out of scope here and
  called out rather than quietly skipped.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified.** Both files are shipped source constants
(`src/data/`, published in `package.json` `files[]`, compiled into `dist/`), so
every machine holds byte-identical copies and computes the same
`registrySourceMatches`. There is no per-machine state, no durable write, no
notice, and no generated URL. The pool-merged read path is unaffected — peers
merge computed findings, not raw sources.

Before this fix the detector was uniformly blind across the fleet; after it, it
is uniformly able to compare. The posture does not change, only the verdict.

## 8. Rollback cost

**Revert the commit.** No flag, no migration, no durable state, no agent-state
repair. Reverting restores the permanent `precondition-failed` behaviour — i.e.
the detector goes back to being silently blind, which is worth stating plainly
because that state is indistinguishable from healthy caution from the outside.

## Second-pass review

**Not required** by the Phase-5 trigger list: no messaging/dispatch block-allow
decision, no session lifecycle, no compaction path, no coherence gate, trust
level, or idempotency check, and nothing named sentinel/guard/gate/watchdog. The
change is a two-character data correction plus a build-time assertion, and every
finding the affected subsystem emits is advisory by construction.

The claim that matters was verified empirically rather than argued: the live
hashes were computed and compared against the mirror (they match — my first
hypothesis was wrong), the two source strings were printed and diffed, the
ratchet was mutation-tested by restoring the original typo (it fails, naming the
separator), and the behavioural pair proves the ladder's outcome flips on that
flag alone.
