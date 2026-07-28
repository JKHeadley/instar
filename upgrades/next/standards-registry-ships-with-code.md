# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`docs/STANDARDS-REGISTRY.md` — the constitution — shipped in **0 of the 9,834 files** `npm pack`
produces. Every reader resolved `<projectDir>/docs/STANDARDS-REGISTRY.md`, the agent-home snapshot
written once at install and never refreshed. Measured 2026-07-26 on a live agent: a **May 24** copy
carrying **22** standards against an authored **81**.

The refresh path could not have worked. `PostUpdateMigrator.migrateFeatureMaturationGate` read
`<bundledRoot>/docs/STANDARDS-REGISTRY.md`, absent from every published install — throwing into
`result.errors` on every fleet run, where nothing looks — and even given the file it gated on ONE
hardcoded prior hash, so any drifted copy was classified "customized" and skipped forever. **No
deployed agent could ever receive an amended standard.**

The constitution is now a build artifact: generated into `dist/data/standards-registry.md` plus an
integrity `.meta.json`, shipped inside the package with the compiled code that reads it, and resolved
module-relative by one new module (`src/core/standardsRegistryPath.ts`) that returns a typed result
and never throws. The machine readers take that result.

**And the agent gets a current rulebook too — which is the half this guide previously got backwards.**
An earlier draft of this paragraph said "the dead migrator entry is removed" and "vestigial
agent-home copies are left in place, unread, so rollback is total". Review falsified *unread*, and it
was the load-bearing word: **you** are the constitution's principal reader, and every prose pointer
shipped to you — the CLAUDE.md sections the migrator writes, plus the spec-converge, instar-dev and
iterative-converging-audit skills — names `docs/STANDARDS-REGISTRY.md`. Fixing only the machine
readers would have left the tooling correct while the agent it exists for kept reading a
fourteen-week-old quarter of the rules.

So the migrator entry is **restored and repointed** at the packed asset, and it refreshes your copy
on every update. It is deliberately ungated: a prior-hash gate cannot tell a customization from
ordinary drift, which is exactly how the old one classified every drifted copy as "customized" and
stopped refreshing forever. It refuses only where the target IS the authored original — an instar
source checkout, detected by three markers (`src/core/`, `docs/specs/`, `.git`) checked before the
file's existence — so it can never revert the document everything else is generated from.

**If you edited your own copy, say so plainly: those edits will be overwritten.** The constitution is
instar's document, not a place for local amendments — if you want one, it belongs upstream, because a
private fork silently stops receiving every other standard. Note this is deliberately UNLIKE most
instar updates, which leave a file alone once you have customised it; that convention is exactly what
let this document sit fourteen weeks out of date. There is a `.pre-feature-maturation-v1.bak` beside
it, but it holds whatever was there at the FIRST update and is never refreshed — so it will not
contain an edit you made later. If you are carrying a local change you care about, copy it somewhere
else now.

**What this means for rollback, stated honestly:** it is mechanically total but no longer free of
persisted state. Your `docs/STANDARDS-REGISTRY.md` is now a real per-machine artifact rewritten on
each update, so reverting leaves whatever the last-installed version wrote — on a downgrade, a newer
rulebook than the reverted code expects. That is benign (machine readers use the packed asset; an
agent reading a slightly newer rulebook is the direction this change exists to produce) and it
self-heals on the next update. What reverting DOES cost is the fix itself: agents go back to grading
against a stale snapshot.

Because reader and data now ship together, "the rulebook is missing" can only mean a **broken**
install, never an old one — so there is no fallback candidate and no old-versus-broken guess.

## Evidence

- Real tarball packed, extracted, verified: constitution present, byte-identical, **81 articles**.
- Refusals, each demonstrated: asset dropped from the package (ratchet, with the actionable message);
  tampered bytes (`integrity-mismatch`); meta absent (`broken-install`); registry absent
  (`broken-install`, never throws); a reader rebuilding the path (lint, exit 1).
- The wiring test found a **fourth** reader that returned an empty standards list silently; the lint
  then found a **fifth** with the same shape.
- Measured 2026-07-28, not carried forward from an earlier draft (the previous figures — 11, 16 and
  8 — were true when written and had gone stale as the suites grew, which is the kind of number this
  change exists to stop people trusting): `standards-registry-asset` **28 passed**,
  `standards-enforcement-auditor` **20 passed**, `PostUpdateMigrator-feature-maturation` **10
  passed** (including two behavioural mirror tests — a drifted constitution restored to
  byte-equality with the packed asset, and the refusal leaving a checkout's authored original
  intact), `extractor-traversal` **4 passed**. 62 total across the four; `npx tsc --noEmit` exit 0.

## Known limits

Guarantees the shipped rulebook IS the authored one — not that the authored one is correct; content
review is still the PR. `standardTitles()` still yields `[]` on an unusable install, but that now
means genuinely broken rather than the everyday fleet case. On a fresh checkout the non-ratchet
assertions are trivially satisfied because `beforeAll` generates the asset; the ratchet is unaffected
since it packs a real tarball regardless.

## What to Tell Your User

Nothing is required of you. After this update your agent reads its engineering standards from the
package itself rather than from a copy saved when it was first installed — so an amended standard
actually reaches it. If you had asked your agent about standards coverage before, the number of
standards it reports will jump (22 → 81 on this machine), because it is finally measuring the whole
document instead of a fragment.

If your agent ever reports that its standards assessment cannot be trusted, that now means its
install is genuinely incomplete and a reinstall is the fix — it will say so plainly rather than
quietly grading against an old copy.

Any old standards file sitting in your agent folder is left exactly where it is and simply no longer
read. You can keep it or delete it.

## Summary of New Capabilities

- The constitution ships with the code that reads it, versioned together.
- Integrity is checked on read: mismatched, missing, or unverifiable rulebooks report an honest
  untrustworthy verdict instead of a confident number over a stale fragment.
- The standards-coverage audit can now reach a `verified` confidence verdict; previously it could
  only ever say `unverified`, because the external expectation it needed did not exist.
