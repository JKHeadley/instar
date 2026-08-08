# Side-effects review — window 10, deep-property guards

## Increment 1 — *Deferral = Deletion* gets a FUNCTION check

**Changed:** `scripts/lint-deferral-referent-resolves.mjs` (new), `docs/deferral-referent-baseline.json`
(new), `docs/STANDARDS-REGISTRY.md` (Applied-through + named residual), `package.json` (lint chain),
`tests/unit/lint-chain-completeness.test.ts` (ratchet registration),
`scripts/lint-no-direct-destructive.js` (one allowlist entry, justified below).

**Why.** The operator's window-10 charter: real guards for the deep Substrate properties, verifying
FUNCTION rather than existence. *Deferral = Deletion* was chosen first because it is the most tractable
of the four — a deferral either points at something or it does not, which is observable — and because
whatever shape works becomes the template for the three that resist checking harder.

**The measurement that made the case.** The pre-existing guard (orphan-deferral step in
`instar-dev-precommit.js`) proves a spec carrying deferral language carries a TRACKING MARKER, and it
does that correctly. But the ids point into per-machine commitment and evolution-action registries —
runtime state, not tracked in the repo — so no build can resolve them. Measured across `docs/specs/`:
**178 distinct tracked deferral ids, 110 (62%) resolving to nothing anywhere in the repository.** For
those, "tracked" was unfalsifiable: the deletion the standard forbids, wearing a tracking number.

**Over-block.** A new tracked id must be mentioned somewhere outside `docs/`. That can annoy an author
who genuinely defers to work that has not started — the mitigation is that a spec section, a test
name, or the code stub all satisfy it; only a marker pointing at nothing fails. Under-block, named:
an id written into a test comment and nowhere else resolves and follows through on nothing.

**A boundary found by getting it wrong.** The resolving corpus is `git ls-files`, so an UNTRACKED file
cannot resolve a marker. My first injection test used the new (uncommitted) script as the referent, saw
a refusal, and I briefly mistook a CORRECT refusal for a broken check. The behaviour is right — an
uncommitted file is not something a reviewer can follow — and it is now documented in the script.

**The baseline is shrink-only.** 81 orphans at the current head (the 110 figure was measured on the
pre-merge tree). The change that DISCOVERS a debt cannot also pay it; new orphans fail immediately.

**The allowlist entry, and why it is not a weakening.** The script calls `git ls-files`, which
`lint-no-direct-destructive` flags. It is a standalone `.mjs` running with no build step, so it cannot
import the TS SafeGitExecutor funnel — the same situation as `cartographer-freshness.mjs` and
`release-skip-annotate.mjs`, both already allowlisted for read-only git. The call is read-only AND
load-bearing: the corpus must be TRACKED files, or a filesystem walk would silently accept referents
that exist for nobody else.

**The enforced ratio rose 0.7356 → 0.7471, and I checked why before accepting it.** Yesterday I nearly
manufactured enforcement twice; the tell was a metric improving on a change that built nothing. Here the
rise is *Deferral = Deletion* moving gap → gate because a guard now exists, is wired into the lint
chain, and is proven three ways. Enforcement genuinely increased. Stating the check explicitly because
the number moving in my favour is exactly the moment to look.

**Negative controls:** a new orphan marker fails by id; the same marker with a referent in a TRACKED
file passes; a deleted baseline refuses to report clean. Registry restored after each.

**Residual, named and dated in the standard:** whether the deferral was actually KEPT is not checkable
by any build-time guard, because the registries live outside the repo. Countdown
`STD-SUBCOUNTDOWN-deferral-closure-unverified`, 2026-09-07.

**Rollback.** Remove the chain entry, the test registration and the allowlist line; delete the script
and baseline. The standard's Applied-through paragraph reverts with the registry.
