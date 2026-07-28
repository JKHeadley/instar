# Side-Effects Review — the constitution ships with the code that reads it

**Version / slug:** `standards-registry-ships-with-code`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

`docs/STANDARDS-REGISTRY.md` — the constitution — appeared in **0 of the 9,834 files** `npm pack`
produces. Every reader resolved `<projectDir>/docs/STANDARDS-REGISTRY.md`: the agent-home snapshot,
written once at install and never refreshed. Measured on this machine: the snapshot was a **May 24**
copy carrying **22** standards against an authored **81**.

Three independent failures held it in place:

1. `docs/` is not in `package.json` `files` → the document ships to nobody.
2. `PostUpdateMigrator.migrateFeatureMaturationGate` refreshed it from
   `<bundledRoot>/docs/STANDARDS-REGISTRY.md`, a path that exists in **no** published install. The
   read threw on every fleet run, was caught, and landed in `result.errors` — unread.
3. That refresh gated on ONE hardcoded prior hash (`9b3f2775…`). The agent's copy was `449e4816…`,
   so it was classified "customized — left untouched" and skipped permanently.

**No deployed agent could ever receive an amended standard.** Migration Parity, violated at the level
of the rulebook itself.

Change: the constitution is generated into `dist/data/standards-registry.md` + `.meta.json` during
the build and resolved module-relative by a single new resolver, `src/core/standardsRegistryPath.ts`.
The readers take the resolver's typed result. A real-tarball ratchet and a lint keep it from silently
regressing.

**CORRECTED — this paragraph previously ended "The dead migrator entry is removed", and that design
was FALSIFIED in round 1.** Removing it would have fixed the three MACHINE readers and left the
constitution's *principal* reader — the agent — on the May-24 snapshot, because every prose pointer
shipped to agents (the CLAUDE.md sections this migrator writes, plus the spec-converge, instar-dev
and iterative-converging-audit skills) names `docs/STANDARDS-REGISTRY.md`. The change's headline
claim would have been false for the reader it exists for.

So the migrator entry is **restored and repointed**, not removed:

- Source is `dist/data/standards-registry.md` (the copy that actually ships), via
  `registryMirrorPaths()` — no path literal in the migrator, and a boundary test enforces that
  exactly one module owns registry location.
- It is **UNGATED** (`alwaysOverwrite: true`). Failure #3 above is precisely what a prior-hash gate
  does: it cannot distinguish a customization from ordinary drift, so it classifies every drifted
  copy as customized and stops refreshing forever. Re-adding a gate would re-add the defect.
- It **REFUSES** when the target is the authored original — an instar checkout, where
  `docs/STANDARDS-REGISTRY.md` is the document everything else is generated FROM and the migrator's
  backup is written only once. Keyed on markers that predate this branch (`.git`, `docs/specs`,
  `src/core`); markers decide BEFORE target existence, so a checkout mid-rebase is still a checkout.

The client-facing flag is `registryCurrent` (not `verified`), with `verifiedKind` naming what was
established. Both are covered below.

## Refusal evidence (constraint 2)

```
REFUSAL 1 — packed asset dropped from the package (the ORIGINAL defect, simulated
            with dist/data/.npmignore, verified to genuinely exclude it)
  × RATCHET: a REAL tarball carries the constitution, byte-identical
    → "package/dist/data/standards-registry.md is MISSING from a real npm tarball — the
       packaging regression this ratchet exists for has returned. The constitution would
       ship to no one … Check: (1) the generator still runs after tsc in package.json
       `build`, (2) no later build step cleans dist/, (3) nothing … excludes dist/data."

REFUSAL 2 — registry bytes tampered (integrity-mismatch)
  usable: false | reason: integrity-mismatch
  → "the packed registry does not match the integrity meta generated alongside it
     (expected sha256 b2663eb675bf…, found …). Rebuild; do not edit dist/ by hand."

REFUSAL 3 — integrity meta absent (broken-install)
  usable: false | reason: broken-install
  → "the packed registry is present but its integrity meta is absent or unreadable …"

REFUSAL 4 — registry absent (broken-install), never throws
  usable: false | reason: broken-install

REFUSAL 5 — a reader rebuilds the path (lint)
  ✖ lint-no-direct-standards-registry-path
     src/core/CartographerNavigator.ts:34: const sneaky = 'STANDARDS-REGISTRY.md';
  exit=1
```

Restored in every case: resolver `usable: true`, **81 articles**; the asset unit file **28 passed** (re-measured round 10 — it said 11, true when written and stale as the file grew; the SAME figure was corrected in the upgrade guide a round earlier and left standing here, which is the sibling-survival class one more time);
`npx tsc --noEmit` exit 0; lint green.

## The guards found what I did not

Recorded because it is the substance of this increment.

I set out to fix **three** readers. **My own test found a fourth** — `AgentServer.ts`'s
`standardTitles()`, which read the snapshot with a private `^###` regex and `catch { return []; }`.
On every deployed agent that returned an **empty list of standards, silently**. Then **the lint found
a fifth** — `src/commands/server.ts:17530`, the same silent-empty-list shape copied verbatim.

That is precisely the pairing the spec argued for and I nearly economised away: the wiring **test**
enumerates files I thought of; the **lint** walks all of `src/`. Neither alone would have found both.

**I also got two proofs wrong, and both passed green before I caught them.**

- Simulating the packaging regression with a ROOT `.npmignore` did nothing — `files` is an allowlist
  that a root `.npmignore` does not override — so the ratchet "passed" while proving nothing. A
  nested `dist/data/.npmignore` genuinely excludes the asset; verified by listing the tarball
  directly before trusting the test.
- Probing the lint by inserting a forbidden string at line 5 of a file also "passed" — line 5 was
  inside that file's top docblock, which the lint correctly strips. Inserting past the docblock made
  it fire.

Both times the green result was mine, not the guard's. **A guard I have never watched refuse
something is not yet a guard.**

One real defect fell out of the second probe: the lint reported **line 3** for a violation on **line
34**, because block-comment stripping collapsed lines. Fixed by replacing each block comment with an
equal number of newlines. A guard that fires correctly but sends you to the wrong place is half a
guard.

## Two defects the full suite found in MY change

Recorded because both were invisible to every check I ran before it.

**1. The resolver did not work under vitest at all.** It locates the asset
module-relative (`../data/…`), which differs by execution layout: `dist/core/…` → `dist/data/`,
but `src/core/…` → `src/data/`. Vitest runs the TypeScript directly, so every test resolved
`broken-install`. My targeted suites passed anyway because they exercise the resolver through a
`dist`-shaped fixture — a fixture that reproduced production and hid the layout the rest of the
suite actually runs in. Fixed by generating into **both** `src/data/` and `dist/data/`: one
resolution rule, correct everywhere, no fallback chain. Both are already in `files`; both are
gitignored build output.

Noted while fixing it: `src/data/builtin-manifest.json` has the same module-relative reader and is
generated ONLY into `src/data/`, so its production read from `dist/data/` cannot succeed. Same defect
class, different feature — verified (`ls dist/data/builtin-manifest.json` → absent), not fixed here.

**2. I removed the only seam that made the audit testable at the route level.** The route-level tests
inject a CONTROLLED constitution (empty, three-article, known-gap, truncated) via `projectDir` to
assert semantic boundaries. Resolving solely module-relative made all of them read the live
81-article document; 22 tests across 8 files failed.

The fix is an EXPLICIT `resolveStandardsRegistry(explicitPath?)`, threaded through a documented
test-only `RouteContext.standardsRegistryPathOverride`. This does not weaken the guarantee, and the
distinction is the whole point: the defect was readers reaching a stale copy **implicitly**, by
constructing `<projectDir>/docs/…` themselves with no one naming it. A path a caller states outright
is visible at the callsite, is never tried *in addition to* the packed asset, and forms no candidate
chain. No production callsite passes it, and the lint still stops a reader building one.

One trap inside that fix: the route originally passed the resolution's sha as the audit's
`expectation`. For an overridden path that sha is derived from the same file moments earlier, so it
could never mismatch — every fixture would have been handed an unearned `verified`. The expectation
is now supplied ONLY for the packed asset, whose meta is generated at build time from the authored
document and is therefore a real check.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| registry vs meta sha256 | `invariant` | Byte comparison. No model, no threshold. |
| meta absent → broken-install | `invariant` | Deterministic. "Could not verify" never reads as usable. |
| `articleCount` | `diagnostic` | **Never invalidates.** Derived from parser behaviour, so a parser change could otherwise take the audit offline over a byte-valid registry. Reported for legibility only. |
| `expectation` → `verified` | `invariant` | Pre-existing seam in `deriveAssessmentConfidence`, documented as awaiting exactly this mechanism. |

No judgment points, no LLM, nothing gated on a model.

## 1. Over-block

The resolver refuses on any sha mismatch. A legitimate mismatch does not exist: the meta is generated
from the same source in the same pass, so a reword regenerates both. The realistic false-positive is a
**stale `dist/`** — a developer who edits the constitution and does not rebuild. That is a true
positive wearing an inconvenient hat, and the message says "Rebuild; do not edit dist/ by hand."

The lint could over-block a legitimate future mention of the filename in `src/`. It strips comments
first, so prose is safe; a genuine new code reference would need the resolver anyway, which is the
point. Allowlist is one entry and easy to extend deliberately.

**Over-block I explicitly did NOT take:** making `articleCount` invalidate. Round 10 of the spec was
right — that turns a parser-rule change into a total audit outage.

## 2. Under-block

**A wrong-but-self-consistent constitution still passes.** If someone edits the authored document
badly, the build ships it and the meta matches. This change guarantees *the shipped rulebook is the
authored one*, not that the authored one is correct. Content review is the PR, as before.

**`standardTitles()` still returns `[]` on an unusable install.** Its callers accept an array; giving
them a throw would be a worse trade. The difference is that `[]` now means a genuinely broken install
rather than the ordinary fleet case.

**No release-time verifier in `prepublishOnly`.** The real-tarball ratchet runs in the unit suite,
which is a required check, and packs the same tree. A `prepublishOnly` step would assert the same
property one stage later; it is redundant with a required check rather than missing coverage.

**Vestigial agent-home copies are not cleaned up.** Deliberate (§7.11) — deleting an operator's file
for tidiness is destructive for zero benefit, and leaving them is what makes rollback total.

## 3. Level-of-abstraction fit

The bug was not that any single reader was wrong — it was that *constructing the path was something
any reader could just do*, and five of them did, two with silent empty-list fallbacks. So the fix is
at the boundary: one module owns resolution, it exports **no raw path** (only the typed result), and
readers cannot shortcut it. The lint is the supplemental half for someone rebuilding the string from
scratch.

## 4. Signal vs authority compliance

The resolver is a **signal producer with no blocking authority**: it returns a verdict and never
throws, never exits, never gates. The readers hold the authority and render `usable: false` as an
honest untrustworthy report with a 200, not a 500. `docs/signal-vs-authority.md` satisfied.

## 4b. Judgment-point check (Judgment Within Floors)

None introduced. Every decision is a byte comparison or a file-existence check.

## 5. Interactions

- **`deriveAssessmentConfidence`** — its `expectation` parameter already existed, documented as
  "Absent today — the mechanism is the `standards-registry-snapshot-refresh` spec." This supplies it.
  Effect: the audit can now reach `'verified'` instead of permanently `'unverified'`.
- **`migrateFeatureMaturationGate`** — one entry **restored and repointed**, NOT removed. ("one entry
  removed" was this line's earlier text and described the design round 1 falsified — see the
  correction in the summary.) It sources `dist/data` via `registryMirrorPaths()`, runs
  `alwaysOverwrite`, and skips on a source tree. Its other entries are untouched; the migrator suite
  is green (10 passed), including two new behavioural tests — a drifted constitution mirrored back to
  byte-equality with the packed asset, and the refusal half leaving a checkout's authored original
  intact. Both proven able to fail by flipping that one flag off.
- **`package.json` `build`** — generator inserted after `tsc` (needs the compiled shared parser) and
  before `chmod`/`sign-lockfile` (neither cleans `dist`).
- **npm lifecycle, checked rather than assumed.** The spec (§3.2) states there is "no `prepack`, no
  `prepare`". `prepack` and `postpack` are indeed absent, but **`prepare: husky` DOES exist**, and npm
  runs `prepare` before `npm pack`. The conclusion survives — `husky` installs git hooks and never
  touches `dist` — but the premise as written was wrong, so it is corrected here rather than
  inherited. The invariant that matters (nothing mutates `dist` between generation and packing) holds.
- **CI unit job runs `npm ci` + tests with NO build.** So `dist/` may be absent there, and `npm pack`
  does not build (`prepare` is husky; `prepublishOnly` runs only on publish). The test's `beforeAll`
  therefore runs a real `npm run build` when the compiled parser is missing. Skipping in that case was
  the tempting alternative and is rejected: it would make the ratchet vacuous on exactly the runs that
  matter — the same absence-reads-as-presence shape as the defect itself.
- **`conformanceCache`** — unchanged; short-circuits on `inputHash` as before. The unusable path
  deliberately does **not** populate the cache, so a repaired install recovers on the next call.

## 6. External surfaces

`GET /conformance/coverage` and `/health` keep their shape; `total` goes 22 → 81 on a built agent and
`registry.path` now points into `dist/data`. `POST /spec/conformance-check` 503s with a named reason
on an unusable install instead of on a missing file. No config, no new route.

**There IS persisted state**, and this line previously denied it — the same falsified-design residue
as the summary and §8. The mirror writes `<projectDir>/docs/STANDARDS-REGISTRY.md` on every update:
a real per-machine artifact, which is why §8's rollback analysis is "mechanically total, not
operationally safe" rather than "no data to repair".

## 6b. Operator-surface quality

Each refusal names the remedy in its first clause and says which of the three causes to check. This
is deliberate: the sibling defect fixed in #1661 was a failure message instructing the reader to do an
impossible thing, and the ratchet's original failure mode here was a bare
`tar: Error exit delayed from previous errors`, which was replaced for the same reason.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified`** (the default, and the correct one here).

**CORRECTED — this section declared the surface machine-local-by-design and carried an
invented justification key, and both halves were wrong.** The spec's §7 reversed them rounds ago;
this artifact kept the original for nine rounds because nothing sweeps a change's paperwork. Round 10
found it, and `scripts/lint-machine-local-justification.js --strict` confirms it deterministically —
an `A2-invalid-taxonomy-key` finding against the key this section used to carry.

*(The literal marker is deliberately not reproduced here. That lint matches the marker pattern
wherever it appears, including inside a quotation of its own error message — so writing the old key
out, even to disown it, makes this file fail the check that proves the correction. The lint's
inability to distinguish a live declaration from a historical quote is itself a defect, and it fires
the same way on the spec's §7; see the note at the end of this section.)*

Two errors, both of the kind that check exists to catch:

1. **The key was outside the closed taxonomy** — the permitted set is
   `physical-credential-locality`, `hardware-bound-resource`, `operator-ratified-exception`.
   Inventing a fourth is precisely the "author's convenience" the taxonomy forecloses. A marker's
   PRESENCE never satisfies the CORRECTNESS check.
2. **The posture itself was wrong.** "The file sits on each machine's disk, therefore machine-local"
   confuses locality of STORAGE with divergence of VALUE. The value does not diverge: every machine
   running instar version X holds a byte-identical constitution, because the asset is generated from
   one authored document and shipped inside that version's package. That is `unified` by definition,
   and declaring it machine-local would have been an *infeasible-locality* finding in the opposite
   direction — the trivial dodge the check calls out as EQUALLY material.

**Unification is structural, not replicated.** The asset travels WITH the code that reads it, so
there is nothing to reconcile at runtime: no lease, no merged read, no generated URL. Two machines on
different instar versions honestly report different `total` values — true and visible rather than
silently reconciled.

**There IS durable per-machine state**, and the earlier text denied it in the same breath as §8
asserted it twelve lines below. The mirror writes `<projectDir>/docs/STANDARDS-REGISTRY.md` on every
update. It is per-install and regenerated from the packed asset, so it does not strand on topic
transfer and needs no replication — but "no durable state" was false and is now stated correctly in
both sections.

**Two things worth recording about the check itself**, because both are more useful than the finding:

1. **It exists and would have caught this in round 1 — it is just not wired into `npm run lint`**
   (verified: zero occurrences in `package.json`). Nine rounds of adversarial review missed a finding
   a deterministic script produces in milliseconds, because nobody ran the script. That is the
   Structure-beats-Willpower argument stated against my own process: the guard was built, and not
   arming it made it worth nothing here.
2. **It cannot distinguish a live declaration from a historical quote.** It fires on the spec's §7,
   which only quotes the bad key while recording its own reversal, and it fired on this file the
   moment the correction above quoted the lint's own error text. So a document cannot currently
   explain what it got wrong without failing the check for saying so — which punishes exactly the
   correction the standard wants. Both are follow-ups rather than fixes here: wiring an
   unconditionally-firing lint into `npm run lint` in the same change that lands this would redden
   the suite on files this change never touched.

## 8. Rollback cost

**MECHANICALLY total, not operationally safe.** The earlier "total and cheap" was an overclaim and it
rested on the same falsified design as the summary above — it said "the agent-home copies are still
on disk untouched … no persisted state, no data to repair", which was true only while the migrator
entry was being REMOVED. With the mirror restored, both halves are false.

Mechanically: revert the commit; readers return to their previous path construction and the generated
`dist/data` artifacts vanish on the next build.

**But there IS now a persisted per-machine artifact.** The mirror rewrites
`<projectDir>/docs/STANDARDS-REGISTRY.md` from the packed asset on every update, so a revert leaves
whatever the last-installed version wrote — on a downgrade, a NEWER 81-article constitution than the
reverted code expects.

That is benign, and worth saying why rather than asserting it: the machine readers use the packed
asset and are unaffected; the mirror is what the AGENT reads, and an agent reading a slightly newer
rulebook than its code is the direction this whole change exists to produce. It self-heals on the
next update because the mirror is unconditional, and it can never clobber an authored constitution
because `registryMirrorPaths` refuses on a source tree.

What genuinely has no rollback cost: no schema, no migration, nothing to repair by hand.

Operationally, **reverting RESTORES THE DEFECT** — agents go back to grading against a stale snapshot
(22 standards against an authored 81 on the machine measured here) and back to a state where no
deployed agent can receive an amended standard. That is a deliberate trade a human may want in an
incident, not a free undo. Monitor both directions keyed on `registry.sha256`, the only value that
distinguishes "took the change" from "reverted" from "never had it".

## Phase 5 — Second-pass review

Touches no gate/sentinel/watchdog, no block/allow authority, no session lifecycle, no trust surface.
The high-risk trigger list is not engaged — the resolver produces a signal and the audit is
observe-only and non-gating. Author lenses:

**Adversarial — "how would I make this useless?"** Four ways, all now asserted: drop the asset from
the package (ratchet), let tampered bytes through (integrity-mismatch), let a missing meta read as
usable (broken-install), or let a reader rebuild the path (lint + API boundary). The fifth — deleting
the tests — is why the lint exists alongside them.

**"Would it have caught the incident?"** Yes, and it did, twice, during this build: the test found the
fourth reader and the lint found the fifth. That is the strongest evidence available that the pairing
is load-bearing rather than ceremonial.

**"Symptom or cause?"** Cause. The symptom was one audit reporting 22; the cause was that the rulebook
did not propagate at all, and that any reader could construct its own path to a frozen copy. Both are
closed.

**Weakest point:** the `beforeAll` that generates the asset when absent keeps the unit file
self-sufficient but means the non-ratchet assertions are trivially satisfied on a fresh checkout —
the same limitation documented for the builtin-manifest check. The **ratchet** is unaffected: it packs
and opens a real tarball regardless. Second weakest: the lint is a text matcher and can be evaded by
constructing the string in pieces; that is why the API boundary (no raw path exported) is the primary
enforcement and the lint is explicitly the supplemental half.
