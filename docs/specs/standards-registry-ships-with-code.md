---
title: "The constitution ships with the code that reads it"
slug: "standards-registry-ships-with-code"
author: "echo"
status: "draft"
created: 2026-07-27
parent-principle: "Migration Parity"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation to Brittle Fallback; Observability — you can't tune what you can't see; Structure beats Willpower; Signal vs. Authority"
lessons-engaged: "honest-denominators (2026-07-25 — an empty index scoring 100% fresh; a gate printing BLOCKED and not blocking); docs-dir-is-not-published (my own memory note, written days earlier and not applied); hook-event-reporter.js (install-if-missing left agents stuck on a broken template); zombie-cleanup-kills-active-sessions (a deployed agent silently running stale configuration)"
origin: "Project convergence-towards-coherence, Tier 1. Supersedes docs/specs/standards-registry-snapshot-refresh.md, which reached its 10-round convergence cap and — more importantly — describes a design that IMPLEMENTATION FALSIFIED in two places (see §2)."
eli16-overview: "standards-registry-ships-with-code.eli16.md"
review-convergence: "2026-07-28T15:49:51.767Z"
approved: true
approved-by: "Justin (operator, topic 29723, 2026-07-29)"
review-iterations: 23
review-completed-at: "2026-07-28T15:49:51.767Z"
review-report: "docs/specs/reports/standards-registry-ships-with-code-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# The constitution ships with the code that reads it

> **This spec is written AFTER the implementation, and says so.** The predecessor
> (`standards-registry-snapshot-refresh.md`) was written before, went ten adversarial rounds,
> never converged, and still got two load-bearing details wrong — both of which only surfaced
> when the code ran against the full suite. Rather than approve a document that describes
> something nobody built, this one describes what exists, what it refuses, and what it cost to
> learn. §2 keeps the falsified claims; they are the most useful content here.

> ## HOW TO READ THIS DOCUMENT — normative vs. record
>
> **§0 and §3 are NORMATIVE.** They describe what exists now. If anything below them disagrees with
> them, §0 wins and the disagreement is a defect worth reporting.
>
> **Every section is classified.** The two rules above left §1 and §4-§7 and
> §9-§12 unstated even though several carry live obligations, so a reader could not tell whether §5
> bound them. The full table:
>
> | section | class |
> |---|---|
> | §0 Current normative contract · §3 Design | **NORMATIVE** — what exists now; §0 wins any disagreement |
> | §4 Build pipeline · §5 Enforcement · §6 Decision points · §7 Multi-machine posture | **NORMATIVE** — live obligations, each required by the convergence gate |
> | §9 Open questions | **NORMATIVE** — unresolved, and binding in the sense that nothing below settles them |
> | §11 Risk/rollback · §12 What this does not do | **NORMATIVE** — they bound the claim; §12 in particular bounds every number in §5 |
> | §1 The defect, measured | **EXPLANATORY** — motivation, not obligation; cite it for *why*, never for *what* |
> | §10 Verification — what actually ran | **RECORD** — true as of its run; re-verify rather than quote |
> | §2 · §8 · the separate review-history file | **HISTORICAL RECORD** — never normative; do not implement from it |
>
> **§2 and §8 are HISTORICAL RECORD, and the per-round history now lives in its own file**
> ([`…review-history.md`](./standards-registry-ships-with-code.review-history.md), rounds 1-9).
> They preserve what was believed, what implementation
> falsified, and what each review round changed — including claims that are now WRONG, kept struck
> through with the correction inline. A reader hitting an original needs to see that it was wrong;
> a tidied document hides that the design carried the error it diagnoses.
>
> **Why this banner exists.** Four consecutive review
> rounds raised "§X contradicts §0" as a defect. Three were genuine — a normative section carrying
> a superseded claim — but the pattern kept recurring because the document did not say which
> sections *may* carry superseded claims by design. Round 1 had already named the underlying shape:
> a spec that appends its own review history grows its reviewable surface every round, so a diligent
> reviewer will always find precision to add on a larger surface, and the loop cannot terminate for
> that document shape. This banner is the structural answer — not fewer corrections, but an explicit
> boundary so a strikethrough in §8 reads as a record rather than a live contradiction.
>
> **The one rule that survives regardless:** correcting a claim means grepping its SUBJECT and
> reading every hit — not the wording you remember writing. Round 3 swept for `never a 500` and
> reported clean; round 4 found `Neither ever returns 500` and `returns 500; neither substitutes`
> still standing.

## 0. Current normative contract

*(This section is the CURRENT contract. Everything from §2 onward is how it got here and why; the
round-by-round review history lives in the companion history file.)*

| | |
|---|---|
| **Production API** | `resolveStandardsRegistry(): RegistryResolution` — **no parameter**. |
| **Fixture API (module export, NOT package-public)** | `resolveStandardsRegistryFromPath(p): RegistryResolution` — zero `src/` callers, asserted. It is a TypeScript module export, **not** a package public export: `exports` carries a single `"."` entry with no subpath patterns and `src/index.ts` re-exports nothing from the module, so `import 'instar/dist/core/standardsRegistryPath.js'` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Reachable only by a hand-built filesystem path into `node_modules/`, or a bundler that ignores `exports`. |
| **Asset location** | `src/data/` **and** `dist/data/` (`standards-registry.md` + `.meta.json`), both gitignored build output, both shipped. |
| **Resolution rule** | module-relative `../data/…`. No discovery, no upward walk, no candidate chain, no fallback. |
| **Failure reasons** | `broken-install` (required artifact absent) · `invalid-meta` (meta absent/malformed) · `integrity-mismatch` (sha disagrees) · `unexpected-error` (a throw — likely a code regression, not an install problem). |
| **Never throws** | Enforced by a catch-all boundary, not by intent. |
| **Runtime guarantee** | **CURRENCY, at the strength it actually has.** `earnsVerified` requires the sha pair, the package-version stamp, and the article count. **Exactly ONE of the three is not derived from the registry bytes** — the version stamp. The count catches parser drift between the generating and reading parsers, not staleness. The remaining gap is closed in the AUDITOR by `compareAgainstAuthoredSource`, **in an instar source tree only** — in an agent home that file is a mirror of the asset, so comparing them would be a tautology. In a published install the question is unanswerable and the version stamp carries the claim. NOT provenance, NOT tamper resistance. |
| **Endpoint status** | Both read routes are dev-gated (`ctx.cartographer` + `resolveDevAgentGate(cartographer.conformanceAudit.enabled)`) and require `X-Instar-Request: 1` — 503/403 respectively before any of the below. Then: read/report **200** with `assessmentTrustworthy: false` on an unusable resolution; action (`POST /spec/conformance-check`) **503**. **An unusable resolution never 500s**; an unexpected auditor throw (parser/extractor) IS a 500 with a named detail, because that is a code regression rather than a data state. |
| **Client contract** | BOTH read routes carry **four** top-level booleans: `usable` (a report was produced at all), `registryUsable` (the constitution itself parsed and passed its canary), `guardsAnalyzable` (there is a source tree to resolve enforcement refs against), and `registryCurrent` (the constitution's provenance was established). Four rather than two because the report has two independent halves — a sound constitution graded against a missing repo is a real and distinguishable state, and collapsing it into one flag reproduced the very failure the flag was added to prevent. One flag could not carry three states — `usable` alone returned `true` for `unverified`, so the stale-but-coherent registry presented as fine to exactly the client the flag was added for. `assessmentConfidence`/`confidenceReason` carry the detail; `enforcedRatio` is `null`, never `0`, when there is no denominator. |
| **Response state** | Four booleans plus `verifiedKind` encode a small state machine: four `coverageState` values over five concrete boolean tuples (§0.1 explains the extra bit). **The truth table is published below this table**, as a table. All five values come from ONE function both routes spread, so the routes cannot drift. |
| **`coverageState`** | The four legal states of §0.1 as a ONE-FIELD enum: `invalid-registry` (a) · `missing-guards` (b) · `usable-unverified` (c) · `package-stamped` (d). **AUTHORITATIVE** — new clients read this. The four booleans are RETAINED for existing readers and are **compatibility-only**: not extended, and no new state may be expressed as a fifth boolean. Derived from the same three values in the same expression as the booleans, so the two forms cannot disagree. Evaluation order follows §0.1 exactly: `registryUsable` is tested FIRST, because a constitution that did not parse makes guard state meaningless. Removal of the booleans is a separate breaking change with its own migration, tracked. **(d) is named `package-stamped`, not `current`** — it establishes that the asset's stamp matches the running package version, which is NOT the same as matching the authored source: package version is not build-unique, so a same-version rebuild satisfies it while content differs (ACT-1463). Four consecutive review rounds objected that `current` reads stronger than the mechanism supports, so the name now states what is established. |
| **Mirror write semantics** | **Already atomic — verified, not asserted.** `durableWrite` opens a temp file `wx` (exclusive), writes, `fsync`s the fd, `rename`s over the target, then `fsync`s the directory. So a partial write, a permissions failure or a crash mid-update leaves the PREVIOUS mirror readable and intact — last-good-mirror semantics come free from the rename. Recorded rather than re-implemented: the property already holds in the code. Concurrency: the temp name carries pid + 6 random bytes, so two simultaneous migrators cannot collide on it. |
| **What the refusal PREDICATE actually tests** | `holdsAuthoredConstitution(dir)` — three markers, ALL required, evaluated BEFORE the target's existence: `src/core/`, `docs/specs/`, and `.git` (a plain file when the tree is a git worktree, which is why the probe stats rather than tests for a directory). Markers first is load-bearing: a checkout mid-rebase or mid-`git rm` is still a checkout, and testing the target first would install the packed asset at the authored path exactly when the constitution is transiently absent. The probe uses `statSync` so an unreadable directory (EACCES) is UNCERTAINTY, not absence, and the catch fails CLOSED — refusing costs an un-mirrored constitution, allowing would overwrite an authored one. Named here because "refuses on an instar source tree" is a description, not a predicate, and a reader cannot check a description. **On Signal vs. Authority:** this predicate is brittle — three filesystem markers standing in for "is this a source checkout?" — and it does gate an operation. What makes that acceptable is the DIRECTION of its authority: it can only ever DECLINE TO WRITE. It never authorizes anything, never marks anything trusted, and never unblocks a path. A wrong answer in one direction costs an un-mirrored constitution on a machine that wanted one; a wrong answer in the other would overwrite an operator's authored file. The standard governs heuristics that GRANT permission — a heuristic whose only power is to refuse to overwrite is the conservative default this design is built on, not an exception to it. |
| **An operator's OWN edits to the mirror** | **Overwritten on the next update. Deliberate.** The constitution is instar's artifact, not a customization surface — a local amendment gets merged upstream rather than held as a private fork that silently stops receiving every other standard. **This deliberately breaks the repo's prevailing install-if-missing convention**, and the break is the point: that convention is what let the constitution sit at 22 articles for fourteen weeks. **The backup is NOT a safety net for this.** `durableWrite(backup, …)` runs under `if (!fs.existsSync(backup))`, and that whole branch sits behind the overwrite guard — so it captures the target as it stood at the **first update that actually OVERWRITES**, not at the first update. An update whose content hash is already accepted never reaches it and writes no backup. The file is never rewritten afterwards, so any edit made after that first overwrite is replaced with no backup OF THAT EDIT. Measured at `PostUpdateMigrator.ts:1439-1441`. |
| **What `registryCurrent` does NOT promise** | It means *the packed asset matches the running package version and a build produced it* — NOT that the asset matches the authored source. Package version is not a build-unique identity, so a same-version republish or a local rebuild can satisfy the predicate while the authored content differs. **Stated HERE, beside the claim, rather than only in §9 and §12** — three consecutive rounds objected that `current` reads stronger than the mechanism supports, and a caveat a reader meets after the guarantee is a caveat they meet after the decision. The two real closures (a build-unique id, or a CI ratchet tying an authored-sha change to a version change) remain deferred <!-- tracked: ACT-1463 --> and are tracked in §9; neither is required for this design to be correct, only for that one operand to be strictly falsifiable. `verifiedKind` names WHAT was established (`packed-asset-current-with-build`) precisely so the boolean cannot be read as generic trust. |
| **Client-facing field name** | `registryCurrent`, NOT `verified`. Three consecutive rounds flagged that `verified` reads as trust or provenance — strictly more than this establishes. The audit keeps `assessmentConfidence: 'verified'` as its internal vocabulary; the boolean a client reads says what it knows. `verifiedKind` accompanies it with the basis. |
| **Build requirement** | Generator runs after `tsc` — a HARD ordering constraint, because it imports the compiled parser. The PUBLISH path enforces a build via the existing `prepublishOnly`; a `prepack` hook was tried and REVERTED (§8e F1 (review history) addendum). `npm run build` is the single command that prepares test assets **for a developer**. |
| **Test-asset bootstrap — TWO paths, deliberately** | CI runs `npm ci` → `npm run test:*` with NO build, so any tier touching the production resolver must bootstrap the asset itself. (a) `tests/setup/build-dist.globalSetup.ts` — used by the unit, integration and push configs: `ensureDistBuilt()` (conditional) THEN `ensureRegistryAsset()` (unconditional), in that order. Both orderings have shipped and both were wrong — below the freshness return it was unreachable on a fresh `dist`; above `tsc` it aborted every shard on CI. (b) `tests/setup/registry-asset.e2e.globalSetup.ts` — e2e ONLY, because that config deliberately builds no `dist` (a compiled `dist/cli.js` wakes dormant tests that spawn `pnpm`, absent on the CI e2e runner). It compiles the parser to a temp dir, writes `{"type":"module"}` beside it so the format is DECLARED rather than left to Node's experimental syntax detection (absent below 20.19, and 20.12 is inside our `engines`), asserts the emit path, and points the real generator at it via `INSTAR_REGISTRY_PARSER_DIST`. |
| **`INSTAR_REGISTRY_PARSER_DIST`** | Env override on `scripts/generate-standards-registry-asset.mjs` naming WHERE the compiled parser is read from. It does NOT change WHICH parser is used, so the one-parser-three-consumers property is intact. Exists solely for (b) above; unset everywhere else, including every build and publish path. |
| **Fleet key** | `registry.sha256` is authoritative; package version is context. Group by sha before comparing totals. **It is now actually present** on `RegistryProvenance` in every report, including the unusable path (carried from `observed.sha256` rather than dropped). |
| **`refResolutionRatio` — the field that says what it measures** | The audit grades from named-reference EXISTENCE: a `ratchet` classification means a ratchet-shaped filename RESOLVES, not that a ratchet ran. That bound now lives in the FIELD NAME. `enforcedRatio` is retained for existing readers and is **DEPRECATED** — same number, a name that claims more than the measurement supports. Both are emitted from one expression and pinned together by a unit test, so the two names cannot drift apart. Every number in §5 and §10 inherits the reference-existence bound. |
| **Why the rename rather than a caveat** | The previous answer was a row telling readers to read §12 before quoting the ratio. A limitation that depends on being remembered is not enforced — it is manual work assigned to every future reader, and the first one to skip it quotes a number that means something else. Moving the bound into the name is the structural form of the same warning, and it travels with the value into every client that reads it. |
| **Scope** | The standards registry ONLY. The identical defect in `builtin-manifest.json` was tracked as **ACT-1311** and is **CLOSED** — merged as PR #1669 (`origin/main` `bffa704d9`) on 2026-07-27, before this document was committed. Note the divergence rather than leaving it unexplained: that fix resolves through a **two-candidate chain** (`../data/` → `../../src/data/`), which the Resolution rule above forbids here. The reason is that the manifest ships via `src/data` in `files` and must resolve in two real layouts, whereas this asset is generated into `dist/data` and has exactly one. Two answers to one problem is a cost of splitting the work; it is recorded, not hidden. |

### 0.1 Response-state truth table

**Four `coverageState` values; FIVE concrete boolean tuples.** The difference is state (a), where
`guardsAnalyzable` may hold either value — so the compatibility booleans expose one diagnostic bit
that the enum does not. Saying "four states" without that qualification would be the same
inferred-value defect this table exists to prevent, one level up.

Every value is listed for the same reason.

| state | `usable` | `registryUsable` | `guardsAnalyzable` | `registryCurrent` | `verifiedKind` |
|---|---|---|---|---|---|
| **(a)** `invalid-registry` — constitution did not parse, or its canary objected | F | F | * | F | `null` |
| **(b)** `missing-guards` — sound constitution, no source tree to resolve refs against | F | T | F | F | `null` |
| **(c)** `usable-unverified` — everything answered, stamp NOT established | T | T | T | F | `null` |
| **(d)** `package-stamped` — everything answered, asset stamp matches the build | T | T | T | T | `packed-asset-current-with-build` |

`*` in (a): `guardsAnalyzable` is computed independently and may hold either value, but it is not
meaningful when the constitution did not parse.

**Illegal by construction:** `registryCurrent: T` alongside any of `usable: F`, `registryUsable: F`,
`guardsAnalyzable: F`. `verifiedKind` is non-null in exactly state (d) — it is derived from
`registryCurrent` in the same expression, so the two cannot disagree.

**What (c) covers:** a fixture path, an unstamped asset, a version skew, a count disagreement, or an
edit that outran the build.

**How the table is held true.** The integration test asserts each input's row against LITERALS written
down independently of the derivation. Importing the shipped function would prove only that the two
routes agree — three earlier versions of that test did exactly that and each passed while unable to
catch a wrong row.


## 1. The defect, measured rather than inferred

`docs/STANDARDS-REGISTRY.md` is the constitution. Readers resolved
`<projectDir>/docs/STANDARDS-REGISTRY.md` — on a deployed agent, the **agent-home snapshot**,
written once at install and never refreshed.

Measured on a live agent, 2026-07-26:

| | |
|---|---|
| `GET /conformance/coverage/health` | `total: 22`, `registry.bytes: 46606` |
| on-disk copy | **May 24**, sha `449e4816…` |
| authored `docs/STANDARDS-REGISTRY.md` | **81** articles, 247,988 bytes, sha `b2663eb6…` |
| `npm pack --dry-run` → `docs/` | **0 of 9,834** packaged files *(`npm pack --dry-run --json` → `entryCount`, re-measured round 10. THIRD value for this one quantity: 9,735 first, "corrected" to 9,835 in round 5 — off by one — and 9,834 is the measured truth. A number corrected once is not thereby correct. The load-bearing half, ZERO, never moved.)* |

Three independent failures held it in place, each verified:

1. **`docs/` is not in `package.json` `files`.** The constitution ships to nobody. (`.npmignore`'s
   own comment: *"the `files` field is the sole authority for what ships."*)
2. **`PostUpdateMigrator.migrateFeatureMaturationGate` refreshed it from
   `<bundledRoot>/docs/STANDARDS-REGISTRY.md`** — a path present in **no** published install. The
   read throws on every fleet run, is caught, and lands in `result.errors`, which nothing reads.
3. **That refresh gated on ONE hardcoded prior hash** (`9b3f2775…`). Any drifted copy — i.e. all of
   them — was classified `"customized — left untouched"` and skipped permanently.

**Consequence: no deployed agent could ever receive an amended standard.** Migration Parity,
violated at the level of the rulebook itself.

**What was NOT wrong.** The audit already reported `assessmentConfidence: unverified`,
`assessmentTrustworthy: false`, and named exactly what it lacked: *"NO external expectation exists
to confirm this is the CURRENT constitution rather than a coherent older copy — a stale registry
passes every internal check by construction."* The instrument was honest.

**What this spec supplies — CURRENCY, not verification.** An earlier draft of this section claimed
it supplies "the external expectation whose absence the audit correctly reported." That was wrong,
and the wrongness was load-bearing: acting on it produced a `verified` verdict resting on a
comparison that could not fail (ACT-1426 — the route derived an expectation from the same
resolution whose sha the auditor then re-computed, past a guard that had already equated them).

The registry does not gain an outside witness here. It stops being able to drift: the constitution
ships as a build artifact beside the code that reads it, so "the reader is current but its data is
stale" becomes unrepresentable rather than detectable. The audit's `verified` verdict therefore
reports one specific fact — *these bytes came from the build that shipped this code* — and
`confidenceReason` states its limits in as many words. It is not a runtime re-derivation from the
authored source (that equality is a build-time assertion), and it is not tamper-resistant.

Worth keeping as a lesson beyond this spec: **a defect closed by construction leaves nothing to
verify at runtime, and the temptation is to perform the verification anyway.** A check whose two
operands share one origin cannot fail, and its green result is indistinguishable from a real one.

**AND THAT CORRECTION WAS ITSELF AN OVERCLAIM — caught one round later.** The paragraph above
originally ended by asserting the sha pair establishes that "these bytes came from the build that
shipped this code." It does not. The generator writes the registry and its meta **on ADJACENT lines
in one loop**, so the pair is self-consistent forever, however old the asset is; `tsc` alone (a
`pnpm dev` watch) recompiles the reader without re-running the generator. "Current reader,
arbitrarily old constitution, internally consistent" was fully representable and resolved as
`verified`. The tautology, one radius out — two operands that are no longer the same *number*, but
which one script writes in one *pass*.

The basis now rests on **three** operands, two of which the generator did not derive from the
registry bytes: the sha pair, a **package-version stamp** written into the meta, and the article
count. `earnsVerified` requires all three and names whichever one fails. Recording the sequence
because the shape recurs: the first fix removed a check that could not fail and replaced it with a
*claim* that could not fail, which is the same error wearing the opposite costume.

**AND THE CHANGE DID NOT YET DO ITS OWN JOB.** §1's conclusion is that no deployed agent could
receive an amended standard. An intermediate draft repointed the three MACHINE readers at the packed
asset and declared the per-install copies "left in place and simply unread" — but *unread* was the
load-bearing word and it was false. The **agent** is the constitution's principal reader, and every
prose pointer shipped to agents (the CLAUDE.md sections this migrator writes, plus the
`spec-converge`, `instar-dev` and `iterative-converging-audit` skills, all of which ship in `files`)
names `docs/STANDARDS-REGISTRY.md`. Measured on a live agent while reviewing this change: **46,606
bytes, 22 articles, dated May 24**, against 81 authored. Repointing the instruments while leaving
the agent reading a fourteen-week-old quarter of the rulebook fixes the measurement and not the
thing measured. The migrator entry is therefore **restored** — repointed at the packed asset (which,
since this change, genuinely ships) and **ungated**, mirroring on every update.

## 2. What implementation falsified in the predecessor spec

Both of these survived ten adversarial review rounds and were still wrong.

**2.1 — "generate into `dist/data/`, resolved module-relative, no fallback."** The resolver locates
its data relative to its own module directory. That directory differs by execution layout:

| layout | resolver at | `../data/` resolves to |
|---|---|---|
| compiled production | `dist/core/standardsRegistryPath.js` | `dist/data/` ✔ |
| vitest (TypeScript source) | `src/core/standardsRegistryPath.ts` | `src/data/` ✘ |

Vitest runs the TypeScript directly, so with `dist/data/` alone **every test resolved
`broken-install`** — 22 failures across 8 files. Worse, the eleven tests written specifically to
prove the resolver works all PASSED, because their fixture reproduces the *compiled* layout and was
therefore structurally blind to the layout the rest of the suite runs in.

Resolution: generate into **both** `src/data/` and `dist/data/`. One rule, correct everywhere, no
fallback chain, no discovery logic. Both are already in `files`; both copies are gitignored build
output. (Cost: ~248 KB duplicated in a 9,834-file package — a FOURTH value for the same quantity survived here, unswept, while the other three were being argued over.)

**2.2 — "no `projectDir` candidate, no injection of any kind."** Taken literally this removes the
only seam that makes the audit testable at the route level. Route tests inject a CONTROLLED
constitution — empty, three-article, known-gap, deliberately truncated — to assert semantic
boundaries. Without it they can only run against the live 81-article document, which is both
brittle and incapable of exercising the edges.

Resolution: an **explicit** `resolveStandardsRegistry(explicitPath?)`. This does not weaken the
guarantee, and the distinction is the whole point of §3.

## 3. Design — one resolver, no implicit candidates

```
TWO exports. The production entry point takes NO argument; fixture resolution is a
separately-named function with zero src/ callers (asserted).

resolveStandardsRegistry()  →  RegistryResolution          [PRODUCTION]
    registry = new URL('../data/standards-registry.md',        import.meta.url)
    meta     = new URL('../data/standards-registry.meta.json', import.meta.url)
    ├─ registry absent            → usable:false  broken-install
    ├─ meta absent / unreadable   → usable:false  invalid-meta
    ├─ sha differs from meta      → usable:false  integrity-mismatch
    └─ sha matches                → usable:true   basis: 'packed-meta-match'
                                                  + markdown (the bytes it read)
                                                  + the three operands below

resolveStandardsRegistryFromPath(p) → RegistryResolution    [FIXTURES]
    ├─ file absent  → usable:false  broken-install, naming the path
    └─ file present → usable:true   basis: 'caller-supplied-path'
                                    (no same-build meta exists, so it can
                                     never earn `verified` — by its BASIS,
                                     not by a callsite remembering to withhold
                                     a field)

earnsVerified(integrity) — ONE predicate, beside the type, every downgrade named:
    caller-supplied-path        → not verified (no same-build meta)
    packageVersionMatches:false → not verified (asset STALE relative to this build)
    packageVersionMatches:null  → not verified (unstamped asset — unknown operand)
    articleCountMatchesMeta:F   → not verified (artifacts disagree on their content)
    articleCountMatchesMeta:null→ not verified (unanswerable — parser could not read)
    all three agree             → VERIFIED (currency, not source-equality, not tamper-proof)
```

```ts
export type RegistryResolution =
  | { usable: true;
      path: string; sha256: string; articleCount: number;
      /** The bytes ALREADY read — consumers must not re-open `path`. */
      markdown: string;
      integrity: RegistryIntegrity }
  | { usable: false;
      reason: 'broken-install' | 'integrity-mismatch' | 'invalid-meta' | 'unexpected-error';
      detail: string; observed?: { path?: string; sha256?: string; articleCount?: number } };

export type RegistryIntegrity =
  | { basis: 'packed-meta-match';
      metaSha256: string;
      metaArticleCount: number | null;
      observedArticleCount: number | null;
      articleCountMatchesMeta: boolean | null;   // null = unanswerable, and that is NOT a pass
      metaPackageVersion: string | null;
      runningPackageVersion: string | null;
      packageVersionMatches: boolean | null }
  | { basis: 'caller-supplied-path' };
```

*(This block is NORMATIVE and complete. The previous version showed
`resolveStandardsRegistry(explicitPath?)` — a signature removed three rounds earlier — and a usable
variant missing `markdown` and `integrity`, i.e. the two fields the design now rests on. A reader
implementing from it would have built something else, which is why "the type block is illustrative"
is not an acceptable answer for a document that is the contract.)*

**A typed union, never a throw.** A throw invites a `catch` that guesses, which is precisely how the
original defect became a fabricated answer. The union forces every caller to name the non-usable
case. It never throws; callers render `usable: false` as an honest untrustworthy report with HTTP
200. **Registry-resolution failures never 500; an auditor or parser exception may**, with a named detail — see §0. The earlier endpoint-wide "never 500" was false of the code.

**Why an explicit path is not a fallback.** The defect was readers reaching a stale copy
*implicitly* — each constructing `<projectDir>/docs/…` itself, with no one naming it, no visibility
at the callsite. An explicitly-supplied path is the inverse: stated outright by the caller, never
tried *in addition to* the packed asset, forming no candidate chain. No production callsite passes
it. The lint (§5) and the API boundary (the module exports no raw path) both remain intact.

**Runtime integrity is ARTIFACT-PAIR CONSISTENCY, not provenance.**
The runtime check proves the registry and the meta beside it are INTERNALLY CONSISTENT and carry the
running package's version stamp. Round 9 flagged the previous phrasing — "came from the same build" —
as still one notch stronger than the mechanism: the pair plus a version stamp establishes artifact
co-consistency *for that version*, which is not the same as identifying a unique build. It does NOT
prove either matches the authored source, and it is not tamper resistance. Authored-source equality
is a BUILD/TEST invariant, asserted in the unit suite — never claimed at runtime. Phrased this way
everywhere so no reader over-reads it.

**THE ASSUMPTION `packageVersionMatches` RESTS ON, stated because three consecutive rounds asked for
it.** The version stamp is the one operand not derived from the registry bytes, and it is falsifiable
only to the extent that a constitution change is accompanied by a version change. Instar's release
process bumps the version on every publish, so in practice it holds — but that is *release
discipline*, a property of the pipeline, not of the artifact. A registry edit rebuilt and
republished under the SAME version would satisfy the predicate while being a different document.
The honest scope is therefore: `registryCurrent` means *this constitution shipped with a build
carrying this version stamp*, and it inherits whatever uniqueness the release process gives that
stamp. Closing the gap properly wants a build-unique identifier or a CI ratchet tying an authored-sha
change to a version change; both are named as follow-ups in §9 rather than built here, because <!-- tracked: ACT-1463 -->
neither is required for the change to be correct — only for this one operand to be strictly
falsifiable. Recorded rather than left implicit: an unstated assumption is the kind of thing that
reads as a guarantee.

**`articleCount` DOWNGRADES on disagreement** (corrected — §0 and §6 are authoritative and this paragraph contradicted them for a round). It derives from
parser behaviour, so a parser bug or a deliberate rule change could otherwise take the whole audit
offline over a byte-valid registry. It earns its place for legibility — a reader sees
`parsed 22, expected 81` rather than two hex strings. It is **compared and acted on** rather than
computed and discarded: `RegistryIntegrity.articleCountMatchesMeta` is one of the three operands
`earnsVerified` walks, and a `false` there returns `verified: false` with that sentence as the
reason. Read the predicate, not this paragraph, if the two ever part again.

**What the downgrade costs, stated so nobody re-argues it into a diagnostic:** the path is
`verified` → `unverified`, NOT `untrustworthy` and NOT a 503. The registry stays usable and the
audit stays online; what is withheld is only the currency claim. That is why the earlier
"diagnostic-only" design was wrong — it avoided a harm that does not exist, at the price of
discarding the one cross-artifact signal capable of contradicting `verified`.

*(This sentence previously ended "without ever changing the verdict" — false of the shipped code,
and sitting FIVE LINES below this same paragraph's heading, which already said DOWNGRADES and
carried a parenthetical noting it had contradicted §0 for a round. I corrected the heading and left
the tail. Seventh instance of that class, and the first inside a paragraph explicitly flagged as
previously self-contradictory. Round 10 caught it.)*

**The resolution carries its bytes.** `RegistryResolution` (usable) returns the `markdown` it
already read. Before that, the same file was opened three times per coverage call — resolver,
`computeInputHash`, `computeCoverage` — and each re-read was also a TOCTOU seam: the integrity
check applied to bytes a later reader was not guaranteed to get. One read closes both.

**What the resolver established travels as a NAMED BASIS, not as a re-checkable expectation**
(ACT-1426). `RegistryIntegrity` is `packed-meta-match` (the sha guard held) or
`caller-supplied-path` (a fixture; no same-build meta exists). The auditor reports on that basis and
performs **no comparison of its own** — a ratchet asserts the function body contains no re-hash and
no sha equality test.

The rejected repair is worth recording, because it is the obvious one: *pass `meta.sha256` as the
expectation instead of `resolution.sha256`.* It does not work. The only `usable: true` branch that
could supply an expectation is reachable solely past `if (meta.sha256 !== observedSha) return
integrity-mismatch`, so all three values are one number by construction. There is no independent
runtime expectation to substitute, and manufacturing one would be the same ceremony wearing a
different name. A fixture still cannot reach `verified` — but now because its basis says so, not
because this callsite remembers to withhold a field.

**Endpoint semantics on an unusable resolution.** Read/report
endpoints (`GET /conformance/coverage` and its `/health` SUB-ROUTE — a diagnostic summary of the
coverage report, NOT the server's readiness probe, which is separate and untouched) return **200** with `assessmentTrustworthy: false` and the
reason — "could not assess" is a valid measurement. Action endpoints (`POST /spec/conformance-check`)
return **503** with the named reason, because they cannot produce a verdict at all. Neither ever
returns 500 for an UNUSABLE RESOLUTION; neither substitutes a candidate. (A code-level auditor or parser throw is a genuine 500 with a named detail — that is a regression, not a data state. See §0.)

**No fallback, no legacy path.** Resolver, readers and data ship in the same package version, so
"this code is running but its data is missing" is only ever a broken install, never an old one.
~~Vestigial `<projectDir>/docs/STANDARDS-REGISTRY.md` copies are **left in place, unread**~~ — **FALSIFIED, see §1.** Those copies are the AGENT's constitution and every shipped prose pointer names them, so they are now MIRRORED from the packed asset on every update (and the mirror REFUSES when the target is an instar source tree, where that file is the authored original rather than a stale copy). Retained wording below for the record — deleting
an operator's file for tidiness is destructive for zero benefit, and leaving them is what makes
rollback total.

## 4. Build pipeline

| Piece | Concretely |
|---|---|
| Generator | `scripts/generate-standards-registry-asset.mjs` — reads the authored document, writes a verbatim copy plus ``{ sha256, articleCount, generatedFrom, packageVersion }` — `packageVersion` read from `package.json` at generate time, and the generator `die()`s (exit 1) if it is absent or empty, so an unstamped asset cannot be produced. It is the ONE operand in the runtime basis not derived from the registry bytes; without it `earnsVerified` reports `unverified` with "no package-version stamp" rather than passing by silence. Asserted end-to-end in `tests/unit/standards-registry-asset.test.ts`` into **both** output dirs. Deterministic, no network. Fails closed and loudly. |
| Order | `generate-builtin-manifest && tsc && **generate-standards-registry-asset** && chmod && sign-lockfile`. After `tsc` because the generator imports the SHARED parser from `dist/`; before the tail steps, neither of which cleans `dist`. |
| Lifecycle, checked | `prepack`/`postpack` absent; **`prepare: husky` DOES exist** and npm runs it before `pack` — it installs git hooks and never touches `dist`, so the invariant holds. (The predecessor spec asserted "no `prepare`"; that was wrong.) |
| One parser, three consumers | Generator, resolver and tests all import `parseStandardsRegistryDetailed`. This MINIMIZES parser skew and tests the expected layouts — it does not make a count mismatch "unreachable" (the earlier wording overclaimed: parser nondeterminism, parser/runtime skew or a stale artifact can still produce a confusing count while the sha matches). The count is diagnostic precisely so such a case cannot take the audit offline. |

## 5. Enforcement

| Guard | What it catches |
|---|---|
| `tests/unit/standards-registry-asset.test.ts` — **real-tarball ratchet** | The asset dropped from the package. Packs for real, lists members, extracts, compares bytes. `--dry-run` is deliberately NOT used: it reports a file LIST and cannot hand you bytes, which is this bug's own sin. |
| validity matrix | tampered bytes, meta absent, registry absent — each asserted in a throwaway `dist`-shaped fixture. |
| stale-copy regression | A 22-article `<projectDir>/docs/` copy present is not preferred; with the packed asset ABSENT it is still not consulted — resolution stops. Asserted from both sides. |
| `scripts/lint-no-direct-standards-registry-path.mjs` | A reader rebuilding the path. Strips comments (preserving line numbers) so it fires on code, not prose. Wired into `npm run lint`, which is a required CI job. |

**The pairing is load-bearing, not ceremonial** — proven during this build: the wiring test found a
FOURTH reader (`AgentServer.standardTitles`, `catch { return [] }` — an empty standards list,
silently, on every deployed agent), and the lint then found a FIFTH (`src/commands/server.ts:17530`)
with the same shape copied verbatim. The test enumerates files an author thought of; the lint walks
all of `src/`. Neither alone finds both.

### 5b. Testing Integrity — the three tiers, named

*(Conformance-gate finding, round 3: the enforcement section listed ratchets and lints but never
stated the tier coverage the Testing Integrity standard requires. The tiers existed; the document
did not claim them, which is the same absence-reads-as-presence shape this spec is about — a reader
could not tell "all three tiers ran" from "the author did not mention tiers".)*

| Tier | Files | What it establishes |
|---|---|---|
| **Unit** | `tests/unit/standards-registry-asset.test.ts` · `standards-enforcement-auditor.test.ts` · `lint-chain-completeness.test.ts` · `extractor-traversal.test.ts` | The resolver, the verdict predicate, the generator's refusals, the ratchets, and the REAL end-to-end `verified` path (no hand-built literals) |
| **Integration** | `tests/integration/standards-coverage-route.test.ts` · `standards-conformance-gate.test.ts` · `conformance-dev-gate-route.test.ts` | Both HTTP routes behind the real auth + intent + dev gates: 401/403/503/200, the `usable`+`verified` pair, the filters |
| **E2E** | `tests/e2e/standards-coverage-lifecycle.test.ts` · `standards-conformance-gate-lifecycle.test.ts` · `scope-accretion-lifecycle.test.ts` | The production initialization path — the feature is ALIVE (200, not 503) when enabled |

**Every guard added by this change is proven by a test that FAILS without it.** That is a stronger
claim than tier presence and it is the one worth auditing: a ratchet that has only ever passed is
indistinguishable from one that cannot fire. Each was verified by re-introducing the defect and
watching the specific assertion fail — the tautology (route and auditor), the truncated
constitution (`die()`, exit 1), the committed floor, the dropped lint on a bad conflict resolution,
the deleted guard file behind the cache, the traversal ref, and the stale-asset-with-matching-sha.

## 6. Decision points touched

| Decision point | classification |
|---|---|
| registry vs meta sha256 | `invariant` — byte comparison, no model, no threshold |
| meta absent → invalid-meta | `invariant` — "could not verify" never reads as usable |
| `articleCount` vs `meta.articleCount` | `invariant` — a comparison of two recorded integers. **It DOWNGRADES** `verified` → `unverified` on disagreement. An earlier draft made it diagnostic-only to avoid a parser change "taking the audit offline"; the downgrade path is `unverified`, not a 503, so that harm does not exist — and the rule was discarding the only genuine cross-artifact signal, guaranteeing the one thing that could contradict `verified` never would |
| `packageVersionMatches` | `invariant` — string equality between the stamp the generator wrote and the running package version. The operand the generator did NOT derive from the registry bytes, and therefore the only reason `packed-meta-match` can make a falsifiable claim at all |
| `assessmentConfidence` verdict (`earnsVerified`) | `invariant` — an ORDERED precedence over deterministic predicates, no weighing. The order is load-bearing and a builder cannot derive it from prose, so it is stated: `total === 0` → untrustworthy · canary objected → untrustworthy · guard tree unanalyzable → untrustworthy · then the basis. A `packed-meta-match` with a failed canary reports `untrustworthy`, NOT `verified`. **`earnsVerified` has exactly one home** (beside the integrity type) and a ratchet refuses any consumer that branches on the basis without it — a forked rule is a rule where the downgrades silently stop applying |
| guard-tree analyzability | `invariant` — TWO existence probes (`src/server/routes.ts`, `src/core`), BOTH required and asserted by NAME rather than by count. A `package.json#name === 'instar'` marker was required in the first version and removed: an agent home carries a full `src/` copy and no `package.json`, so it made `untrustworthy` the permanent verdict on the only deployment where this surface is live. Verifies the state the audit depends on rather than a symbol standing in for it; a partial tree yields a partial denominator, which is the same lie in a smaller size |
| explicit path honoured | `invariant` — presence of an argument, nothing inferred |

> No `judgment-candidate` points: not one of these weighs competing signals, so there is no floor or
> arbiter to declare. No LLM, nothing gated on a model. Signal-vs-authority: the resolver produces a
> verdict and holds no blocking authority; readers decide.
>
> **Why the registry and the guards are now separately classified.** The two halves of this audit
> come from DIFFERENT places since this change — the registry from the packed asset, the guards from
> `projectDir`. Three independent reviewers raised the same consequence: on an install whose
> projectDir is not an instar checkout, the route table and symbol index return empty SILENTLY,
> every ref dangles, every standard classifies `documented-only`, `enforcedRatio` reads 0 — and the
> registry resolved fine, so the verdict read `verified`. Absence of the repository was
> indistinguishable from absence of guards, and this change made it MORE confident (that same
> reading was `unverified` before). Precedent for the shape is in-tree: `/release-readiness` returns
> null on any install with no analyzable repo rather than a confident zero.
>
> `articleCount` was classified `diagnostic` in an earlier draft. That is not one of the two classes
> the Judgment Within Floors standard defines, and inventing a third is the same move the
> multi-machine taxonomy forecloses in §7. It is deterministic, so it is `invariant`; that it never
> invalidates a verdict is a property worth stating, not a class of its own.

## 7. Multi-machine posture

**Posture: `unified`** (the default, and the correct one here).

My first draft of this section declared `machine-local BY DESIGN` with
`machine-local-justification: none-required`. That was wrong twice, and it is worth stating why
because both errors are the ones the Standard-A check exists to catch:

1. **`none-required` is not in the closed taxonomy.** The permitted keys are
   `physical-credential-locality`, `hardware-bound-resource`, `operator-ratified-exception`. Inventing
   a fourth key is exactly the "author's convenience" the taxonomy forecloses. A marker's PRESENCE
   never satisfies the CORRECTNESS check.
2. **The posture itself was wrong.** I reasoned "the file sits on each machine's disk, therefore
   machine-local" — but locality of *storage* is not the question. The question is whether the VALUE
   diverges per machine. It does not: every machine running instar version X holds a byte-identical
   constitution, because the asset is generated from one authored document and shipped inside that
   version's package. That is the definition of `unified`. Declaring it machine-local would have been
   an *infeasible-locality* finding in the opposite direction — the trivial dodge the check calls out
   as EQUALLY material.

**How unification is achieved — structurally, not by replication.** Coherence comes from the asset
travelling *with* the code that reads it, so there is nothing to reconcile at runtime: no lease, no
merged read, no replication path, **(CORRECTED)** the mirror IS durable per-machine state — see §1 and §8.6; it is written from the packed asset on every update and therefore self-heals rather than stranding on topic transfer, no generated URL.
Replicating it would be actively harmful — it would let a machine hold a constitution its own code
was not built against, which is the drift this spec removes.

**Honest edge:** two machines on DIFFERENT instar versions will report different `total` values. That
is version skew, not constitution divergence — each is correctly paired with its own code, and the
difference is visible rather than silently reconciled. The existing machine-coherence guard already
treats version skew as its own signal.

## 8. Frontloaded decisions

1. Generate into both `src/data/` and `dist/data/`; accept ~248 KB duplication.
2. ~~sha is the sole integrity signal; `articleCount` never invalidates.~~ **REVERSED:** the count downgrades `verified` on disagreement, and the sha is not the sole signal — see §0.
3. Meta-absent is INVALID, not "unverified-but-usable".
4. Explicit override exists, is test-only, and is documented as such at every layer.
5. **The resolver supplies a NAMED BASIS, not an expectation.** `packed-meta-match` with all three operands agreeing is the only basis that earns `verified`; the auditor performs no comparison of its own (ratcheted, both in its own body and in the route that feeds it). The earlier wording here — "expectation supplied only for the packed asset" — described the design ACT-1426 REMOVED, so a builder reading the frontloaded-decisions list would have re-implemented the ceremony.
6. ~~Vestigial agent-home copies left in place, unread.~~ **REVERSED:** mirrored from the packed asset, `alwaysOverwrite`, with a refusal when the target is an authored instar source tree.
7. ~~The migrator's registry entry is REMOVED, not repaired — it maintained nothing.~~ **REVERSED — see §1 and §8.6.** It maintained nothing because it read `<bundledRoot>/docs/…`, a path in no published install, behind a single frozen hash. Both are fixed rather than abandoned: the entry is RESTORED, sourced from `dist/data/standards-registry.md` (which now genuinely ships), `alwaysOverwrite: true`, and REFUSING when the target is an instar source tree. An implementer following the struck text would have reintroduced the core defect this spec exists to close.
8. No overlay / local-amendment mechanism. Amending the constitution is a PR to the authored
   document; a per-install override would add exactly the divergence surface this removes.
9. `src/data/builtin-manifest.json` has the identical defect (module-relative reader, generated only
   into `src/data/`, absent from `dist/data/`). Verified, recorded, **not fixed here** — different
   feature, its own blast radius. <!-- tracked: ACT-1311 -->

## 8b-8j. Cross-model review history (rounds 1-9) — MOVED

Relocated to [`standards-registry-ships-with-code.review-history.md`](./standards-registry-ships-with-code.review-history.md).

It is RECORD, not contract, and it was 32% of this document — surface every reviewer had to read to
review the design. Round 1 diagnosed that shape as the reason the review loop cannot terminate; the
banner was the cheap answer and round 13 measured it insufficient. Moving the record out is the fix
that addresses the cause. Nothing was deleted.

## 9. Open questions

*(none)*

> The three decisions review surfaced are recorded in §9b rather than parked here — a spec cannot
> converge with a live decision resting on the operator.

## 9b. Deferred work — each carrying a tracked id <!-- tracked: ACT-1438 -->

Moved out of §9 deliberately: these are RECORDED DECISIONS, not open questions. A section headed
"Open questions" that answers "(none)" and then lists nine paragraphs is confusing to a reader and
indistinguishable from live parked work to any tool that reads it.

Three things were raised in review and deliberately NOT built here. Each is registered, because the
difference between a deferral and a deletion is whether something re-surfaces it: <!-- tracked: ACT-1438 -->

- **ACT-1438** — the constitution ships twice (`src/data` + `dist/data`, ~248 KB duplicated in every
  published install). Round 7. Deferred because a `files` change at landing time buys packaging risk <!-- tracked: ACT-1438 -->
  for bytes.
- **ACT-1439 — RESOLVED, implemented. Kept here as the record of how.** The client
  contract is a state machine encoded as four booleans; an enum was proposed. Round 10, first
  appearance — deferred then because an enum reads as a breaking client change, and because the <!-- tracked: ACT-1439 -->
  `verified` → `registryCurrent` rename was only made after THREE independent rounds converged,
  which was the bar it had not yet met. Round 11 raised it again; **round 12 raised it a third time
  and met that bar.** The deferral's premise also failed: the proposal was NON-breaking (add <!-- tracked: ACT-1439 -->
  `coverageState`, KEEP the booleans), so "breaking client change" was an objection to a version of
  the proposal nobody had made. Implemented in §0 — `coverageState` is authoritative, the four
  booleans are compatibility-only, and removal is a separate tracked change.
  **Round 15 caught this entry still saying "deferred" after §0 said "adopted"** — a live <!-- tracked: ACT-1439 -->
  contradiction created by updating one section and not sweeping for the subject, which is the exact
  failure this document's own banner warns about.
- **ACT-1463 — the two real closures for `packageVersionMatches`**: a build-unique identifier, or a
  CI ratchet tying an authored-sha change to a version change. The assumption it rests on is STATED
  in §3 rather than left implicit, which is the honest half. Neither closure is required for this
  change to be correct — only for that one operand to be strictly falsifiable.

  **The id is cited here because it was missing, and the heading above claims otherwise.** Review
  caught that this section promised "each carrying a tracked id" while this entry carried none —
  and ACT-1463 exists precisely because a round-12 review found these deferrals had been logged as <!-- tracked: ACT-1463 -->
  filed when they were not. So the sentence was false, and the row it was false about was the one
  recording an earlier version of the same mistake. Fixed by making the claim true rather than by
  softening it.

1. **When does the deprecated `assessmentTrustworthy` boolean go?** Decided: it is removed in the
   release AFTER this one ships, and that removal is registered as a tracked action rather than an
   HTML comment (the §8h F5 (review history) lesson — a comment is not tracking). It is listed in §11 as a
   user-visible response change, because removing a field from a live JSON response is never cheap
   regardless of a deprecation note.
2. **Does the action endpoint re-resolve, or re-use the resolution's bytes?** Decided: **re-use the
   bytes.** It now parses `deps.registryResolution.markdown`. Re-resolving per request was the
   alternative and is strictly worse here: it would re-read and re-hash 248 KB on every spec review
   for no new guarantee, when the integrity check the resolution already carries is the thing that
   matters. The cost is that a resolution built at boot stays stale until restart if an operator
   repairs a broken install underneath a running server — recorded, and preferable to a per-request
   hash.
3. **Does the fixture export get a packaging ratchet now that its encapsulation is load-bearing?**
   Decided: yes, and §8j F3 (review history)'s premise is corrected — the export is NOT reachable by package
   specifier. `exports` carries a single `"."` entry with no subpath patterns and `src/index.ts`
   re-exports nothing from this module, so `import 'instar/dist/core/standardsRegistryPath.js'`
   fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The residual reach is a hand-built filesystem path
   into `node_modules/`, or a bundler that ignores `exports`.

## 10. Verification — what actually ran

> **SCOPE OF THESE NUMBERS (review finding).** The suite figures below were produced against a tree
> whose merge-base with `origin/main` is `5f36d7a`, while main had moved 94 commits to `5dc5bf7`.
> They therefore attest to a tree that no longer exists. They are retained because they are what
> actually ran, and re-stated after the rebase rather than quietly refreshed. **Specific merge
> hazard to resolve deliberately:** this branch appends `lint-no-direct-standards-registry-path.mjs`
> to the `lint` chain at the same position where main has since appended
> `lint-rollout-evidence-resolvable.js`. Resolving that line "ours" silently deletes a required lint
> from CI and NOTHING fails — the guard just stops running, which is the same invisible-guard-loss
> class this whole spec is about. **Keep both, and assert it.**


- **Suite: 2,762 files / 41,899 tests passed, 0 failed** (`npm run test:push`, EXIT=0).
- `npx tsc --noEmit` exit 0. `lint-no-direct-standards-registry-path` green.
- Real tarball packed, extracted: constitution present, byte-identical, **81 articles**.
- Resolver verified in BOTH layouts: compiled `dist` → usable/81; vitest source → 11/11 pass.
- Five refusals demonstrated by breaking it on purpose (§5), each restored afterward.
- Refusals re-verified AFTER the override seam was added — a seam like that is exactly how a guard
  quietly stops biting.

## 11. Risk, blast radius, rollback

**Fleet rollback is not repo rollback.** Reverting the commit is the MAINTAINER's undo; a deployed
agent's undo is a re-publish or a version pin, bounded by release + auto-update cadence. State both,
because only one of them is available to someone holding a broken install.

**The blast radius changed shape and that is the real risk here.** A bad registry used to be ONE
agent's stale file. It is now fleet-synchronous: if a build ships a mismatched pair, every agent on
that version simultaneously reports `usable:false`, `POST /spec/conformance-check` 503s, and
`standardTitles()` returns empty — and there is deliberately **no runtime off-switch** that restores
a working read (the feature flags disable the features, not the resolution). That trade is accepted
because the generator now `die()`s on a canary failure, a count shrink, or an unstampable version,
so `npm run build` fails and `prepublishOnly` cannot publish an unassetted or truncated tree
(verified: exit code 1 on a deliberately truncated constitution).

**User-visible changes, both of them.** (1) `total` goes 22 → 81 on a dev-gated built agent — and
ONLY there; on a fleet agent the conformance surface is dark, so nothing changes. (2) The one review
flagged as more consequential: `assessmentConfidence` becomes `'verified'` for the first time on
every healthy install — it was previously unreachable by construction. A dashboard rendering
`assessmentTrustworthy: true` beside `enforcedRatio: 0.54` reproduces the honest-denominators
failure this spec cites as its founding lesson, which is why `confidenceReason` carries the limits
in words and why the deprecated flat boolean is scheduled for removal (§9).


**Rollback is MECHANICALLY total, not operationally safe** — the earlier "total and cheap" was an
overclaim, and review was right to call it (the same reflex as the integrity and
"unreachable" overclaims: mechanical ease quietly standing in for safety).

Mechanically: revert the commit; readers return to their previous path construction and generated
artifacts vanish on the next build.

**But "no persisted state, no data to repair" is no longer true, and it was the reason this
paragraph read as low-risk.** Restoring the migrator mirror means an updated agent has a REAL
per-machine artifact: `<projectDir>/docs/STANDARDS-REGISTRY.md`, rewritten from the packed asset on
every update. So a revert leaves whatever the last-installed version wrote — on a downgrade, a
NEWER 81-article constitution than the reverted code expects.

That is benign, and worth saying why rather than asserting it: the machine readers use the packed
asset, so they are unaffected; the mirror is what the AGENT reads, and an agent reading a slightly
newer rulebook than its code is the direction this whole change exists to produce. It self-heals on
the next update, because the mirror is unconditional. And it can never clobber an authored
constitution, because `registryMirrorPaths` refuses when the target is an instar source tree.

**This is not a contradiction of the pairing premise, and round 9 was right that the spec had never
said why.** The premise — constitution and code ship together — is a claim about the MACHINE
readers: the parser, the auditor and the gate resolve enforcement refs into a specific tree, so a
constitution naming guards that code does not have produces a wrong *measurement*. The mirror serves
a different reader with a different failure mode: the agent reads the constitution as GUIDANCE, and
guidance that is slightly ahead of the code costs nothing an agent cannot absorb, whereas guidance
fourteen weeks stale is the defect this change exists to remove. So the two readers get opposite
tolerances by design — machine readers must be version-coupled (which is why they read the packed
asset that ships with the build), agent-facing prose must be current (which is why the mirror is
unconditional). A single rule over both would have to pick one failure, and picking either is worse
than distinguishing them.

What genuinely has no rollback cost: no schema, no migration, nothing to repair by hand.

Operationally: **reverting RESTORES THE DEFECT.** Agents go back to grading against a stale
agent-home snapshot — 22 standards against an authored 81 on the machine measured here — and back to
a state where no deployed agent can receive an amended standard. That is a deliberate trade a human
may want in an incident, not a free undo. Rollout and rollback should both be monitored keyed on
`registry.sha256` (§0), which is the only value that distinguishes "took the change" from "reverted"
from "never had it".

**Blast radius:** five readers, one migrator entry, the build script, and `files`-adjacent packaging.
User-visible change: `total` goes 22 → 81 on a built agent and `registry.path` points into the
packed asset; `POST /spec/conformance-check` 503s with a named reason on an unusable install rather
than on a missing file.

## 12. What this does not do

### The instrument this change feeds grades "enforced" from a FILENAME

Stated here because review found it and not fixing it is defensible, while shipping a
document that never mentions it is not — especially when §0 and §11 promote
`assessmentConfidence: 'verified'` as newly reachable on every healthy install.

`classifyFileGuard` awards the top rank, `ratchet`, to any ref matching
`/\.test\.(ts|js|mjs)$/` whose file `existsSync` returns true for. **Measured: 5 test files carry an unconditional `.skip(`, 20 use `.skipIf(`, 29 carry either** (`grep -rlE '\.(skip|skipIf)\(' tests/`). Earlier drafts said 40, and before that 44 — neither figure was ever measured. Citing an invented number as evidence for a claim about measurement honesty is the defect this spec exists to remove, so the command lives beside the figure. A skipped test, an assertion-free test, and a test excluded
from the CI shards all resolve exactly like one that runs and fails on regression. Route
refs are matched by a `router.<verb>('…')` regex in source, so a route that 503s
fleet-wide grades `gate`. Symbol refs now at least ignore comments (fixed this round),
but a symbol in dead code still counts.

This contradicts two articles of the constitution the instrument grades:

- **Verify the State, Not Its Symbol** — which names **filename** in its own list of
  things that may not stand in for proof.
- **Quantitative Claims Must Bind a Subject** — `enforcedRatio` was documented as "the
  fraction of standards with a verified structural guard" while measuring "the fraction
  of standards naming at least one path that exists".

**What landed here** is the same repair this change made one layer up, where the resolver
stopped performing a check it could not do and named its basis instead:

- `VerifiedGuard.verified` → **`refResolves`**. The old name asserted the guard works.
- `CoverageSummary.enforcementBasis: 'named-ref-existence'`, with
  `enforcementBasisMeans` carrying the sentence so the meaning travels with the number.
- The `enforcedRatio` docstring now says what it measures.

**What did NOT land, deliberately:** a grader that establishes a guard actually runs —
parsing for `.skip`, cross-referencing the CI shard config, checking a route's dev-gate.
That is a rebuild of the classifier and it is out of scope for a change about how the
constitution is DELIVERED. The corroborating tell that this is real rather than
theoretical is already in the constitution: the *Maturation Path* standard hand-tunes
around it, its **Applied through** reading *"The test ratchet exists separately but is
deliberately not an enforcement citation: the auditor must classify this standard by its
live gate, not by test precedence."* An author working around your grader is your
grader's review.

Tracked as its own action rather than a note here, per the §8h F5 (review history) lesson that a comment
is not tracking.



Guarantees the shipped rulebook IS the authored one — **not** that the authored one is correct.
Content review remains the PR. `standardTitles()` still yields `[]` on an unusable install, but that
now means a genuinely broken install rather than the everyday fleet case.
