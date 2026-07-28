---
title: "The constitution is read from the build that ships it — deleting the per-install snapshot"
slug: "standards-registry-snapshot-refresh"
author: "echo"
status: "draft"
created: 2026-07-25
parent-principle: "Verify the State, Not Its Symbol"
sibling-principles: "Migration Parity; No Silent Degradation to Brittle Fallback; Observability — you can't tune what you can't see; Structure beats Willpower; Close the Loop; Never-Waste Feedback — corrections compound"
lessons-engaged: "honest-denominators (2026-07-25: an empty index scoring 100% fresh; a gate printing BLOCKED and not blocking) — this is the same audit's instance 4, the stale-input arm; docs-dir-is-not-published (MY OWN memory note, written days earlier and NOT applied — TWICE in one evening: it named both the unpublished-docs trap AND 'anchor to a src/data constant instead'; a cross-model reviewer found each in one pass); hook-event-reporter.js (install-if-missing left agents stuck on a broken template — the precedent draft 1 followed, before review showed the copy itself was the mistake); zombie-cleanup-kills-active-sessions (a deployed agent silently running stale configuration)"
origin: "Project convergence-towards-coherence, Tier 1 item 1 (ACT-1243). Verified first-hand 2026-07-25: GET /conformance/coverage/health reported total 22 / enforcedRatio 0.0455 while the source registry carried 81 article headings (real ratio 0.5432)."
eli16-overview: "standards-registry-snapshot-refresh.eli16.md"
---

# The constitution is read from the build that ships it

> **Rewritten clean at round 7.** Rounds 1–6 each refined this design and I applied their
> findings by patching individual sections. Round 7 correctly reported the result: remnants of
> three superseded designs were still scattered through §4, §7, §9 and §3.3, so "an implementer
> could ship the wrong fix." Patching is what produced that, so this is now a single coherent
> statement rather than a sixth patch. §2 keeps the wrong turns — they are the most useful
> content here — but they are quarantined in §2 and nowhere else.

## 1. The defect, verified rather than inferred

The standards enforcement-coverage audit reads `<projectDir>/docs/STANDARDS-REGISTRY.md` — the
**agent-home snapshot**. Both readers resolve it that way: `src/server/AgentServer.ts` (the
`createSpecReviewRoutes` registration) and the `conformanceReport()` closure in
`src/server/routes.ts`.

Measured on this machine, 2026-07-25:

| | article headings | bytes | enforcedRatio |
|---|---|---|---|
| agent-home snapshot (what the audit read) | 22 | 46,606 | 0.0455 |
| source registry (the real constitution) | 81 | 247,988 | 0.5432 |

The instrument answering *"are our rules actually enforced?"* had been answering over a quarter
of the constitution, and its figure was **12× more alarming than reality**. It was relayed to the
operator as fact. It was also blind to an ENFORCED standard — `Self-Hosting`, under a family the
parser never looked at (fixed separately in PR #1641).

## 2. Three wrong turns, kept because they are the finding

**Draft 1 — wrong root cause.** I blamed `migrateFeatureMaturationGate`'s conservative refresh
policy (overwrite only when the on-disk hash is a known-stock one) and proposed making that one
file always-overwrite. Review asked where the copy is refreshed FROM after packaging. Checking
rather than answering from belief: `package.json`'s `files` list does not include `docs/`, and
`<install>/docs/STANDARDS-REGISTRY.md` is absent from the real installed package. So the existing
migration has been throwing on that file on **every** fleet install since it was written — the
copy was never frozen by caution, it was never reachable. My proposed fix would have hit its own
"nothing to copy from" branch and done nothing, on every ordinary agent, by design. **And eight
unit tests passed while proving none of that**, because they run in a source checkout where
`docs/` exists — a green suite over the wrong environment.

**Drafts 2–5 — six mechanisms, each forced by the one before it.** Reading from an unpublished
authored directory meant I needed a published copy; a copy needs an updater; an updater needs an
is-it-customised policy; that needs an old-install-versus-broken-install discriminator; that
needs a fallback; the fallback needs a degraded-trust state. Rounds 2–5 refined all six. Round 6
observed the whole chain was downstream of one choice, and dissolved it: **treat runtime data as
runtime data.**

**Draft 6 — right idea, wrong path.** I placed the runtime asset at `src/data/` and claimed
`new URL('../data/…', import.meta.url)` was depth-independent. Round 7: it is relative to the
importing MODULE, and the module runs from `dist/`, so it resolves `dist/data/` — not `src/data/`.
The design was correct one level up and wrong at the level that actually runs.

**And twice, my own note said it first.** `docs-dir-is-not-published`, written days earlier, names
both the unpublished-`docs/` trap AND "anchor to a src/data constant instead". I had it in front
of me and built six mechanisms away from it. That is the argument for structure over memory, made
at my own expense: **a lesson in memory is not a mechanism.**

## 3. Design — one path, one state machine

The runtime registry is a **build artifact under `dist/data/`**, generated from the authored
document and packed with the compiled code that reads it.

```
RESOLVER (one module — the only place a registry path is constructed):

  registry = new URL('../data/standards-registry.md',        import.meta.url)
  meta     = new URL('../data/standards-registry.meta.json', import.meta.url)

  ├─ both present + registry VALID per meta (§3.1) → USE IT.  trustworthy: true
  ├─ registry present + INVALID                    → STOP.   trustworthy: false + reason
  ├─ registry absent                               → STOP.   trustworthy: false, 'broken-install'
  └─ meta absent                                   → STOP.   trustworthy: false, 'broken-install'
```

**The resolver's contract is a typed result — not a throw, not a nullable string**
(round-10 finding 1: "STOP" was underspecified, and an implementer could have shipped any of three
shapes):

```ts
export type RegistryResolution =
  | { usable: true;  path: string; sha256: string; articleCount: number }
  | { usable: false; reason: 'broken-install' | 'integrity-mismatch';
      detail: string; observed?: { path?: string; sha256?: string; articleCount?: number } };
```

It NEVER throws. Both readers handle `usable: false` by rendering the honest untrustworthy report —
`assessmentTrustworthy: false` with `reason`, `detail` and whatever `observed` counts exist — and MUST
NOT crash the endpoint or turn it into a 500. A discriminated union is chosen over a throw precisely
because a throw is what the merge-base defect turned into a fabricated answer: an exception invites a
`catch` that guesses, while a union forces the caller to name the non-usable case. §9.6 asserts both
readers return 200 with an untrustworthy body rather than an error.

**There is no fallback and no legacy path.** The resolver, the compiled readers and the data ship
in the same package version, so "this code is running but its data is missing" is only ever a
broken install — never an old one. An install predating this change cannot execute this resolver
at all. Consequently: no package-root discovery, no `projectDir` candidate, no
old-versus-broken discrimination, no degraded-trust state. Those states do not exist to be kept
consistent.

**Why `dist/data`, resolved module-relative** (round-7 findings 2 and 5): the resolver compiles to
`dist/core/standardsRegistryPath.js`, so `../data/…` resolves to `dist/data/…` — the same place in
a built source checkout and in an installed package, because `dist` is already published and the
layout is identical in both. No `../..` counting, no upward walking, no `package.json` name match
(circular), no workspace or nested-fixture ambiguity, and — **expected, not guaranteed** — no new
entry in `files`. Round-9 finding 2 is right to flag that: `dist` is in the published `files` list
today, so `dist/data/*` should ride along, but this entire spec exists because someone trusted a
packaging assumption. **The tarball verifier is the authority, not the `files` field**; the
inclusion claim is a prediction the verifier checks, and if it turns out false the fix is one
`files` entry plus a red check that told us. The installed
paths are exactly:

| | path |
|---|---|
| resolver module | `<pkg>/dist/core/standardsRegistryPath.js` |
| runtime registry | `<pkg>/dist/data/standards-registry.md` |
| runtime meta | `<pkg>/dist/data/standards-registry.meta.json` |

**Unsupported runtime mode — CHECKED, not asserted (round-8 finding 3; round-9 finding 4 asked
whether real workflows would be hurt).** I looked instead of claiming: **zero** scripts in
`package.json` run TypeScript directly (no `tsx`, no `ts-node`); `build` is
`generate-builtin-manifest && tsc && chmod && sign-lockfile`, and every runtime entry point is
compiled output. So no current developer workflow is degraded by this.

Should someone later add a TS-direct command, `../data` would resolve under `src/data` where nothing
is generated, and the resolver reports `broken-install` — an honest REPORTED verdict, not a crash and
not a silent read of some other file. §9 exercises the resolver under the dev commands the repo
actually defines (enumerated there), so this stays a checked fact rather than a standing assumption.

**The generator's insertion point is therefore exact:** immediately after `tsc` in the `build`
chain — after compile (so `dist/` exists) and before `chmod`/`sign-lockfile` (neither of which
cleans `dist`).

**Nothing generated is committed.** Both runtime files are build output like the rest of `dist`,
so there is no committed-artifact/dirty-tree question and no regenerate-then-diff dance. The
authored document stays exactly where humans review it: `docs/STANDARDS-REGISTRY.md`.

**Vestigial `<projectDir>/docs/STANDARDS-REGISTRY.md` copies become unread.** They are **left in
place** — deleting an operator's file for tidiness is destructive for zero benefit, and leaving
them is what makes rollback total.

**One entry is removed from `migrateFeatureMaturationGate`'s `files[]`:** the registry. It has
only ever produced an error entry on the fleet, and it now maintains nothing.

### 3.1 Validity — a generated expectation, not a threshold I guess

`dist/data/standards-registry.meta.json` is generated from the authored document in the same
build as the registry copy, carrying `articleCount`, `sha256` and `generatedFrom`.

| registry vs meta (same build) | verdict |
|---|---|
| `sha256` matches | **valid** — integrity established, full stop |
| `sha256` differs | **INVALID** |
| meta absent | **INVALID — broken install** |

`articleCount` is **diagnostic only** and never invalidates on its own.

**Round 10 pushed this further than round 9, and was right again.** Round 9 got me to say the hash is
the sole integrity signal; I then still left a count mismatch INVALIDATING, which round 10 correctly
flagged as an outage risk: the count is derived from parser behaviour, so a parser bug or a
deliberate parser-rule change could take the whole audit offline over a byte-valid registry. And with
one shared parser (below), a count mismatch while the hash MATCHES is unreachable — identical bytes
parse identically — so the only reachable count mismatch is one where the hash already differs, which
is invalid on its own account.

The count therefore earns its place for exactly one honest reason: **legibility.** A reader sees
`parsed 22, expected 81` instead of two hex strings. It is reported beside every verdict and it
decides nothing.

**Why any hash mismatch is invalid.** The meta is generated FROM THE SOURCE IN THE SAME BUILD as the
registry copy. If the shipped bytes differ from the meta generated alongside them, they did not come
from the same content — a stale build directory, a wrong lifecycle order, an edited artifact. A
reword regenerates the meta in the same pass, so there is no legitimate mismatch to tolerate.

**One parser, three consumers (round-8 finding 2).** The generator, the release verifier and the
runtime resolver import the SAME exported article-heading parser rather than reimplementing it —
which is what makes a hash-match/count-mismatch state unreachable, and what stops parser drift from
producing a spurious diagnostic.

**Why meta-absent is INVALID rather than "unverified".** The meta ships beside the code that reads
it, so its absence is an incomplete install — and "I could not verify" reported as usable is
precisely the absence-reads-as-presence failure this project exists to remove.

**Invalid never degrades into a confident answer.** An invalid or absent registry produces
`assessmentTrustworthy: false` with the parse counts and the mismatch attached — the surface
PR #1641 already built. It never falls through to another candidate, because there is none.

### 3.2 Build + verification pipeline, named rather than assumed

This spec exists because prose said something the wiring never did, so the wiring is named.

| Piece | Concretely |
|---|---|
| Generator | `scripts/generate-standards-registry-asset.mjs` — reads `docs/STANDARDS-REGISTRY.md`, writes `dist/data/standards-registry.md` (verbatim copy) and `dist/data/standards-registry.meta.json` (`articleCount`, `sha256`, `generatedFrom`). Deterministic, no network. |
| When it runs — EXACT ORDER (round-8 finding 1) | `pnpm build` runs: (1) clean `dist/`, (2) `tsc` compile, (3) **then** the generator writes `dist/data/*`, (4) then verification/packaging. The generator MUST run AFTER clean and compile — a clean step running later would delete `dist/data`, and the artifact would be silently missing from the package: this spec's own defect, reintroduced through build ordering. Asserted by a test that runs the REAL build and checks the artifact survives it, never by reading the script. |
| Per-PR check | A step in the existing **`Repo Invariants`** job (`invariants` in `.github/workflows/ci.yml`, already a required status check): after build, assert `sha256(dist/data/standards-registry.md) === sha256(docs/STANDARDS-REGISTRY.md)` and that the meta matches both. Inherits required status rather than adding a gate nobody has adopted. |
| Release check — wired into the path publish ALREADY takes (round-9 finding 1) | The verifier runs as a step of the existing **`prepublishOnly`** chain (today: `npm run build && npm run check:upgrade-guide && npm run check:contract-evidence`), which `npm publish` invokes itself. Verified: there is no `prepack` script, and `prepublishOnly` already rebuilds — so a verifier there inspects the exact tree publish then packs. A separate `npm pack` in a CI step would verify a DIFFERENT pack invocation and prove nothing about the published artifact, which is precisely the trusting-a-proxy mistake this spec exists to remove. `scripts/verify-standards-registry-asset.mjs` asserts **authored document == `dist/data/standards-registry.md` == the meta** (three-way, by sha256) over that tree, and additionally produces a real `npm pack --json --pack-destination <tmp>` tarball in CI to confirm the include actually carries the files. |
| Why a real pack | `npm pack --dry-run` reports the file LIST and cannot hand you bytes. An inclusion-only check would trust a listing instead of the artifact — this spec's own sin. Dry-run is the cheap per-PR inclusion signal only, never the guarantee. |
| Lifecycle invariant (round-10 finding 2) | The design relies on nothing mutating `dist/` AFTER verification. Today that holds — no `prepack`, no `prepare`. Because "it holds today" is exactly the assumption that produced this spec, it becomes an ASSERTED invariant rather than a hope: a repo-invariants check fails if a `prepack`/`prepare`/`postbuild` script is introduced without the artifact verifier re-running after it. A future maintainer adding one gets a red check explaining why, not a silently missing asset. |
| Failure behaviour | **Fail closed.** A mismatch fails the check and blocks the release; it never regenerates-and-continues. A verifier that quietly repairs a mismatch is the silent-no-op class wearing better clothes. |

## 4. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Registry path resolution (module-relative `dist/data`, single candidate) | **invariant** | One deterministic path with no alternatives to weigh. No competing signals, so a judgment rung would add ambiguity without adding information. |
| Validity verdict (valid / INVALID per §3.1) | **invariant** | A deterministic comparison against a same-build generated expectation, with a single conservative default: anything other than an exact match is invalid. |
| Whether an INVALID or absent asset may yield a usable reading | **invariant — always NO** | Fixed by design. Any arbiter with discretion to "use it anyway" reintroduces the confident-reading-over-a-fossil behaviour being removed. |
| Whether to delete vestigial agent-home copies | **invariant — always NO** | Destructive for zero functional benefit; also what makes rollback total. |

No decision point here gates information flow, blocks an action, or chooses among competing
signals, so no `judgment-candidate` arises and no arbiter is declared.

## 5. Multi-machine posture

**Version-scoped unified.** Every machine reads the artifact built into ITS installed package.
Same version ⇒ byte-identical content. Different versions mid-rolling-update ⇒ deliberately
different content, exactly as their code differs, which is correct: a machine should be judged
against the rules its own code carries. Nothing to replicate — the content is a function of the
installed version, not of accumulated per-machine state, so there is no divergence a sync could
fix.

| Surface | Posture |
|---|---|
| Registry path resolution | version-scoped unified |
| Audit output (`/conformance/coverage*`) | version-scoped unified (already a per-machine read of per-machine code; `?scope=pool` is not introduced or changed here) |
| Vestigial agent-home copies | unified (inert — unread, so they cannot diverge in any way that affects behaviour) |

No surface is machine-local, so no `machine-local-justification` marker is required and none is
claimed. The bidirectional check holds: `unified` is also *feasible*, because the content derives
from the package rather than from a credential or hardware binding.

**Skew must be diagnosable, not merely intended.** The `registry` provenance block from PR #1641
already carries the resolved path, bytes, article headings and parsed count; this spec adds the
**package version** beside them, so a reader comparing two machines mid-rollout can tell version
skew (expected) from a broken install (not). Without the version, "these two disagree" is
unattributable — the same absence-of-information failure, one level up.

## 6. Self-Heal Before Notify

**N/A — no monitor, watcher or recurring notice source is added.** This changes a path
resolution, adds a build step and two CI checks, and removes one migration entry. The only
operator-visible signal is the existing `assessmentTrustworthy` field on a read-only endpoint
(PR #1641), which is a pull surface, not a raised notice. No escalation path exists to gate
behind a self-heal step.

## 7. Frontloaded Decisions

1. **Runtime data is a `dist/data` build artifact, resolved module-relative.** Not `src/data`
   (round 7: compiled code runs from `dist`, so `../data` resolves under `dist`), not a published
   `docs/` path, and not a per-install copy.
2. **Unsupported runtime mode — CHECKED, not asserted (round-8 finding 3; round-9 finding 4 asked
whether real workflows would be hurt).** I looked instead of claiming: **zero** scripts in
`package.json` run TypeScript directly (no `tsx`, no `ts-node`); `build` is
`generate-builtin-manifest && tsc && chmod && sign-lockfile`, and every runtime entry point is
compiled output. So no current developer workflow is degraded by this.

Should someone later add a TS-direct command, `../data` would resolve under `src/data` where nothing
is generated, and the resolver reports `broken-install` — an honest REPORTED verdict, not a crash and
not a silent read of some other file. §9 exercises the resolver under the dev commands the repo
actually defines (enumerated there), so this stays a checked fact rather than a standing assumption.

**The generator's insertion point is therefore exact:** immediately after `tsc` in the `build`
chain — after compile (so `dist/` exists) and before `chmod`/`sign-lockfile` (neither of which
cleans `dist`).

**Nothing generated is committed.** Build output, like the rest of `dist` — which removes the
   committed-artifact, dirty-tree and regenerate-then-diff questions entirely.
3. **The authored document stays at `docs/STANDARDS-REGISTRY.md`.** Humans review markdown where
   it is written; the program reads the built artifact. CI asserts they match by hash.
4. **No fallback, no legacy path, no degraded-trust state.** Resolver and data ship together, so a
   missing asset is a broken install (§3).
5. **Any mismatch against the same-build meta is INVALID** — hash or count. No tolerance for a
   reword, because a reword regenerates the meta in the same pass.
6. **Meta absent is INVALID, not "unverified."** Absence reported as usable is the exact failure
   class this project removes.
7. **Verification uses a real packed tarball, not `package.json` or a dry-run listing.** The
   `files` field and a dry-run list are symbols; the tarball is the state.
8. **The pack-time verifier FAILS CLOSED and never auto-regenerates.** Auto-fixing recreates the
   quiet-no-op class.
9. **CI wiring lands in the existing required `Repo Invariants` job**, not a new gate that would
   have to be adopted as required before it enforced anything.
10. **Direct path construction is forbidden by a lint**, not only by a test (§9.7).
11. **Vestigial agent-home copies are left in place, unread.** Not deleted, not migrated.
12. **The registry entry is REMOVED from `migrateFeatureMaturationGate`** rather than repaired —
    it maintains nothing once the readers use the resolver.
13. **No overlay / local-amendment mechanism is introduced.** The supported way to amend the
    constitution is a PR to the authored document. A per-install overlay would add a merge
    surface — exactly where a silent divergence would hide — to solve a problem nobody has.

## 8. Open questions

*(none)* — every question raised across seven review rounds is resolved into §7.

## 9. Verification — the bar is "it refused something", and the tests must run in the INSTALLED layout

Draft 1's tests all passed while proving nothing about an ordinary install. That failure shapes
this plan: the decisive assertions run against a **packed-install layout**, not the source tree.

1. **Real-tarball packaging ratchet.** `npm pack --json --pack-destination <tmp>` produces a
   tarball; `dist/data/standards-registry.md` and `.meta.json` are extracted from it and asserted
   byte-equal (sha256) to the authored document and its regenerated meta. FAILS if either asset is
   ever dropped from the package — the regression that made this whole class invisible.
2. **Resolution in the installed layout.** A `node_modules/<pkg>/dist/**` fixture — the layout
   every ordinary agent runs from — resolves the packed asset. This is the assertion draft 1 could
   not have made.
3. **Resolution in a built source checkout.** The same single rule resolves `dist/data`, with no
   special case.
3b. **The artifact survives the REAL build, in order** (round-8 finding 1): run the actual build
   end to end and assert `dist/data/standards-registry.md` + `.meta.json` exist afterwards. A test
   that merely reads the script's steps would pass while a later clean step deleted the artifact.
3c. **One parser, three consumers** (round-8 finding 2): generator, verifier and runtime resolver
   all import the same article-heading parser — asserted statically, so parser drift cannot make a
   byte-valid registry read INVALID.
3d. **Every real dev command** the repo defines is exercised against the resolver (round-8
   finding 3), so an unsupported TS-direct path reports `broken-install` rather than silently
   resolving something else.
4. **A stale agent-home copy is NOT consulted.** A fixture with a 22-article
   `<projectDir>/docs/STANDARDS-REGISTRY.md` present AND a valid packed asset resolves the packed
   asset; and with the packed asset ABSENT, the stale copy is still not consulted — resolution
   stops and reports `broken-install`. The live defect, asserted from both sides.
5. **Validity matrix, every row of §3.1** — including the regression an earlier
   self-contradiction would have encoded: **`sha256` differs while `articleCount` MATCHES must
   refuse.** Plus count-differs ⇒ INVALID, meta-absent ⇒ INVALID.
6. **Invalid never yields a usable reading.** In each INVALID case the reader reports
   `assessmentTrustworthy: false` with counts and reason, and no candidate is substituted.
7. **Wiring integrity, enforced by a lint rather than a vague assertion.** (a) Both readers — the
   coverage audit and the spec-conformance gate — take their path from the resolver module,
   asserted by stubbing the resolver and observing both follow it. (b)
   `scripts/lint-no-direct-standards-registry-path.mjs` fails the build on any construction of a
   `STANDARDS-REGISTRY` path outside the resolver, joining the repo's existing `lint-*` family in
   the invariants job. A test can be deleted; a lint is what stops a future reader silently
   reacquiring the bug. **Round-9 finding 5 is right that a lint alone is brittle**, so it is the
   cheap half of a pair: the resolver is the only EXPORTED way to obtain the path (the readers take
   it as a parameter and never build one), which is the API boundary; the lint catches someone
   bypassing that boundary with a string. Neither alone is sufficient — the boundary can be
   sidestepped, and a text lint can be evaded by construction — which is why both ship. Round-10
   finding 4 is right that the lint is the SUPPLEMENTAL half, not the mechanism: the primary
   enforcement is that the resolver module exports no raw path at all (it exports the typed result
   above), so there is nothing for a caller to shortcut. The lint catches the remaining case —
   someone rebuilding the string from scratch — and is deliberately narrow. The lint's
   own matcher strips comments before matching, for the reason recorded in the merge-base wiring
   test: a text check that reads prose describing the forbidden shape fires on nothing.
8. **Integration tier.** `GET /conformance/coverage/health` against the installed-layout fixture
   reports `total` equal to the packed asset's article count and `registry.path` pointing at it.
9. **E2E tier.** The production initialization path resolves the packed asset and the live endpoint
   reports the whole constitution with `assessmentTrustworthy: true`.

End-to-end, the operative proof is the running server reporting `total: 81` after the release
carrying this change is taken — a condition of the registered autonomous run
`run-ms13zzrz-78576404`, so it cannot be quietly skipped.

## 10. Alternative designs considered

| Option | Verdict |
|---|---|
| **`dist/data` build artifact, module-relative (CHOSEN)** | One path, no copy, no migration, no fallback, no committed artifact, no new `files` entry. Reader and data are versioned and shipped together. |
| Always-overwrite per-install snapshot (draft 1) | Rejected: inert on the fleet, because the source it copies from is unpublished. Even repaired, it maintains a mutable copy of an immutable document — the defect class, patched rather than removed. |
| Publish `docs/STANDARDS-REGISTRY.md` and read it from the package (drafts 2–5) | Rejected: needs a new `files` entry, a package-root helper, and — as round 7 showed — does not even resolve correctly from compiled code. `dist/data` needs none of that. |
| Committed `src/data` copy + regenerate-and-diff in CI (draft 6) | Rejected: a committed generated file fights the dirty-tree guard at release, and compiled code resolves `../data` under `dist` anyway. Build output belongs in build output. |
| Generated JS module exporting the text + hash (or a bundler asset plugin / package asset manifest) | Rejected, and this is the closest alternative (round-10 finding 5). It would remove runtime file resolution entirely — a real advantage. Against it: a generated module carrying ~250 KB of markdown as a string literal compiles into `dist` and enters the module graph of every importer, and it makes the constitution unreviewable as a diff in the form people actually edit. The readers already accept a path, and the failure we care about is REPORTABLE as a verdict (`usable: false`), whereas a module-resolution failure surfaces as a crash. A bundler asset plugin would add a build-tool dependency to solve what a copy solves. |
| Embed the registry text into the built JS bundle | Rejected: a ~250 KB string compiled into `dist` inflates every import path that transitively reaches it, and it makes the constitution invisible to a reader diffing the repo. The readers already take a PATH, so a filesystem artifact needs no adapter. |
| Content-addressed asset loaded by `import`/URL | Rejected: moves the failure from "file missing" (which §3 reports honestly as an untrustworthy READING) to a module-resolution error at import time, which surfaces as a crash rather than a verdict. |
| Manifest with content hash + version | **ADOPTED in minimal form** (§3.1) — a build-GENERATED `articleCount` + `sha256`, not a hand-maintained manifest. My round-1 argument that "the package version is enough" was wrong for the reason review gave: the failure WAS a wrong assumption about package contents, so the contents are exactly what must be asserted. |
| Repoint readers at the source repo | Rejected: no ordinary install has the source repo. Draft 1's stated reason for keeping a copy — correct premise, wrong conclusion. |

## 11. Risk, blast radius, rollback

**Blast radius.** One generator script wired into `pnpm build`; one resolver module; two call
sites changed to use it; one lint; two CI steps; one entry removed from a migration list. No new
runtime behaviour, no gate, no threshold, no config key, no persisted state.

**The real risk.** A reader whose resolution changes picks up a *different* constitution than
before — which is the point, but it means a fleet agent's reported enforcement figure will move
(upward, from a fragment to the whole). That is a correction, not a regression, and PR #1641 makes
the before-state legible: an agent still reading a fragment reports it untrustworthy with its
counts attached.

**Rollback.** Revert the commit; resolution returns to `projectDir` and the fleet reads whatever
copy it has. Nothing is deleted, so rollback is total — which is why vestigial copies are left in
place (§7.11).

## 12. Standards this feeds back

**On code.** Migration Parity says always-overwrite for built-in hooks. One layer up, and
sharper: **a file the runtime reads as an INPUT should be resolved from the artifact that ships
it, never copied into mutable per-install state.** Copy-then-maintain needs an updater, a
customization policy, a backup story and a drift detector — four mechanisms — and here the copy
was never even reachable. Read-from-build needs none of them.

**On process.** `Never-Waste Feedback` currently relies on a lesson being remembered. Twice in one
evening my own written note named the exact trap I then walked into — once for unpublished
`docs/`, once for the `src/data` anchor. The proposed amendment is that the standard names a
structural surface — **a lint that fails when a runtime path resolves under a directory the
package does not publish** — because the alternative is a note I have now demonstrably failed to
read at the moment it mattered.
