# Review history — standards-registry-ships-with-code

**This is the RECORD, not the contract.** It preserves every cross-model review round's findings and
their resolutions, including claims that were later falsified — kept struck through with the
correction inline, because a reader hitting an original needs to see that it was wrong.

**Nothing here is normative.** If anything below disagrees with the spec, the spec wins and the
disagreement is a defect worth reporting. Do not implement from this file; do not quote it as a
current design decision.

**Why it lives in its own file (round-13 finding).** Round 1 diagnosed the shape: *"a spec that
appends its own review history grows its reviewable surface every round, so a diligent reviewer will
always find precision to add on a larger surface, and the loop cannot terminate for that document
shape."* The first answer was a banner declaring the boundary — cheap, and measured insufficient:
round 13 raised the same objection anyway and asked for actual separation. This is that separation.
The history was 309 lines, 32% of the spec, and every round of it was surface a reviewer had to read
to review the design.

Spec: [`standards-registry-ships-with-code.md`](./standards-registry-ships-with-code.md)

---
## 8b. Round-1 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, verdict MINOR ISSUES. All four were material and all four are resolved in
code or in this document. Recorded rather than silently folded in.

**F1 — clean-checkout lifecycle for the gitignored `src/data/` asset.** Both copies are build
output, and vitest resolves `src/data/`. On a fresh checkout with no build, a test that exercises
the PRODUCTION resolver path would therefore see `broken-install` — an honest verdict, but a
confusing one to debug.

Resolution: `tests/unit/standards-registry-asset.test.ts`'s `beforeAll` runs the REAL build when
`dist/core/StandardsRegistryParser.js` is absent (the generator imports the shared parser from
`dist/`, so it cannot bootstrap itself), and the plain generator otherwise. Route-level tests are
unaffected because they pass an explicit fixture path. Skipping when `dist` is absent was rejected:
it would make the ratchet vacuous on exactly the runs that matter.

**F2 — "TESTS ONLY" was policy, not enforcement.** `resolveStandardsRegistry(explicitPath?)` is an
ordinary exported API; the lint catches a reader REBUILDING a path string but not future production
code feeding the override a config- or env-derived value. This is the strongest of the four: it is
the same *structure-beats-willpower* gap as the original defect, one layer up.

Resolution: two assertions, not prose. (a) No production wiring may set
`RouteContext.standardsRegistryPathOverride` — asserted against `AgentServer.ts` and
`commands/server.ts` with comments stripped. (b) The override may never be derived from
`process.env` or a `config.` expression anywhere in `src/`. Both fail with a message naming the
defect they prevent.

**F3 — 200-vs-503 read as contradictory.** §3 says an unusable resolution renders as HTTP 200 with
an untrustworthy body rather than a 500 (a code-level auditor throw is still a 500 — see §0); §11 says `POST /spec/conformance-check` 503s. Both are correct
but the spec did not distinguish them. Disambiguated: **read/report endpoints**
(`GET /conformance/coverage`, `/health`) return **200** carrying `assessmentTrustworthy: false` plus
the reason — the measurement is "we could not assess", which is itself a valid report.
**Action endpoints** (`POST /spec/conformance-check`, which must grade a spec against a real
constitution) return **503** with the named reason, because they cannot produce a valid verdict at
all. Neither returns 500 for an unusable resolution, and neither substitutes a candidate. An auditor/parser exception IS a 500 with a named detail — see §0; the earlier unqualified wording here was false of the code.

**F4 — staleness of the generated asset after a source edit.** Resolution: the byte-equality
assertion (`generated == authored`, and `meta.sha256 == sha256(generated)`) runs directly in the
unit suite, independent of pack ordering — so "authored registry edited, assets not regenerated" is
caught by a direct comparison rather than inferred from a packaging side effect. The tarball ratchet
is the separate, additional guarantee that what was generated actually SHIPS.

## 8c. Round-2 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, verdict MINOR ISSUES. Five findings; all resolved. Two required code changes.

**F1 — `/health` returning 200 on an unusable registry is operationally risky.** The concern is
right in general (monitors read 200 as "safe to serve") but rests on a naming collision worth
removing: `GET /conformance/coverage/health` is a **sub-route of the conformance feature**, not the
server's readiness probe. It is a diagnostic summary of the coverage report, and nothing routes
traffic on it. Clarified in §3 and named here so the next reader does not have to re-derive it. The
server's actual readiness endpoint is separate and untouched by this change.

**F2 — "never throws" was under-specified.** Correct, and this was API *intent* rather than an
implementation invariant: hashing, encoding, permissions and parser failures can throw from paths
the inner handlers do not individually guard. Resolved in CODE — `resolveStandardsRegistry` now
wraps the entire body in a catch-all that maps any unexpected throw to
`usable: false, reason: 'broken-install'` with the error text attached. A resolver that throws is
precisely what invites the guessing `catch` this module exists to prevent, so the promise is now a
guarantee rather than a property someone must re-verify by inspection.

**F3 — the integrity language overclaimed.** Also correct, and it matters because overclaiming is
the exact failure mode this project is about. `sha256(registry) == meta.sha256` proves **package
self-consistency** — these bytes came from the same build as the meta beside them. (Round 9 refined
this further still: the pair plus the version stamp establishes co-consistency *for that version*,
which is not the same as identifying a unique build. §3 carries the current wording and the
release-discipline assumption it rests on; this paragraph is the round-3 record and is left as
written, per the HOW TO READ boundary.) It does NOT prove
either matches the authored source at runtime, and it is **not tamper resistance**: anyone who can
edit the registry can edit the meta. Authored-source equality is asserted in the unit suite at BUILD
time. The runtime check catches a stale `dist/`, a wrong lifecycle order, or a hand-edited artifact —
non-adversarial package consistency. Corrected in the code comment and here.

**F4 — dual generation deserves an alternatives note** (so it is not cargo-culted). Rejected
alternatives: configuring vitest to run the compiled layout (slows every test run and makes the test
tree diverge from what developers edit); resolving from package root (upward walking / `package.json`
matching — the discovery logic this design exists to avoid); embedding the 248 KB document in a TS
module (bloats every import of the resolver and makes the constitution a code artifact); package
`exports`/`imports` subpath conditions (does not help — vitest still executes the TS source, so the
condition resolves to the same source-tree directory). Duplication of a build artifact was the
cheapest correct answer.

**F5 — the override enforcement is defense-in-depth, not complete.** Accepted as stated. The two
assertions catch the reachable shapes (production wiring setting the field; the field derived from
`process.env` or a `config.` expression) but regex checks can miss indirect construction through a
helper. Recorded honestly as defense-in-depth rather than claimed as complete; the primary
enforcement remains that no production callsite passes an argument at all, and the resolver exports
no raw path to shortcut.

## 8d. Round-3 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, verdict MINOR ISSUES. Two findings were REPEATS-with-escalation — the reviewer
raised the override seam for the second consecutive round. A repeat is a signal that the previous
resolution was insufficient, and it was.

**F2 (repeat) — the override remained a POLICY seam.** Round 2 I answered this with regex
assertions and called it defense-in-depth. That was still willpower wearing a test's clothing: an
indirect helper routes around a regex. Resolved STRUCTURALLY — the conformance route now honours
`standardsRegistryPathOverride` **only when `process.env.VITEST` is set**. The test runner sets that
variable; production sets it never. The seam is therefore unreachable in a deployed agent even if
the RouteContext field were somehow populated, rather than merely un-set-by-convention. Asserted.

**F4 — `standardTitles()` returning `[]` was still a silent-degradation shape.** Correct, and it is
the core defect class of this whole project: an empty standards list is indistinguishable from a
legitimately empty constitution at the callsite. The signature must stay array-returning (its
callers require it), so the fix is to make the emptiness LOUD — both implementations now
`console.warn` naming the resolution reason and stating plainly that this is a broken install, not
an empty constitution. Asserted in both files.

**F1 — test asset generation is not globally reliable.** Accepted as a real limitation. The
`beforeAll` guarantees assets for its own file, and every OTHER test that touches the conformance
surface passes an explicit fixture path, so no test depends on generation side effects from another
file. A single-file run of the asset test builds what it needs; a single-file run of a route test
needs nothing. Recorded as the maintenance cost it is rather than claimed as a global guarantee.

**F3 — dual generation couples source-tree tests to packaged runtime assets.** Accepted and named
as a maintenance cost: **any new execution layout must prove resolver location explicitly** rather
than assume the two current ones exhaust the space. That invariant is stated here so a future reader
adding (say) a TS-direct runtime entry point knows the resolver's location is a thing to verify, not
inherit.

## 8e. Round-4 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, verdict MINOR ISSUES. The override finding arrived for the THIRD consecutive
round. Three repeats is not the reviewer being pedantic — it is me narrowing policy three times
instead of removing the hazard once.

**F2 (third repeat) — the optional path parameter was a public API footgun.** Each prior round I
constrained who *currently* passes it (regex assertions, then a VITEST gate on the route). The
reviewer's point stood every time: the hazard is the parameter's EXISTENCE on the primary API,
because the next caller can use it regardless of what today's callers do. **Resolved by removing
it.** `resolveStandardsRegistry()` now takes no argument at all; fixture resolution lives in a
separately-named `resolveStandardsRegistryFromPath(path)` with **zero `src/` callers, asserted**.
The route no longer performs path-based resolution in any form — it accepts a pre-resolved
`RegistryResolution` (still VITEST-gated) that tests construct themselves. A production caller
cannot pass a path to the production API because the parameter does not exist.

**F1 — `npm pack` could ship a stale tree.** New and correct as a concern. My first resolution was
wrong, and the full suite caught it.

I added `prepack: npm run build`. Three existing suites then failed with
`SyntaxError: Unexpected token 'G', "Generated "... is not valid JSON`: **npm interleaves
lifecycle-script stdout with `npm pack --json` output**, so the build's progress lines corrupt the
JSON that those tests — and any consumer — parse. That is a real defect introduced by the fix, worse
than the gap it closed.

**Reverted.** The enforcement that matters already existed: `prepublishOnly` runs `npm run build`,
and npm invokes it on `npm publish` — the actual release path. Bare `npm pack` is an inspection
tool, and breaking `--json` for every consumer to harden it is a bad trade. The test now asserts
`prepublishOnly` builds AND that `prepack` has not been reintroduced, naming the failure it caused.

Recorded rather than quietly reverted: a fix whose cost exceeds its benefit is a finding, and I only
learned it because the full suite ran.

**F3 — the `*health` naming convention.** Accepted as a documentation obligation rather than a
rename (renaming a live route is a separate, user-visible change). The contract is stated explicitly
in §3: this sub-route returns 200 with a body that must be inspected; `assessmentTrustworthy` is the
field to read; it is NOT a readiness probe and nothing should route traffic on it.

**F4 — cross-machine aggregation should group by version + registry sha.** Correct, and honestly
OUT OF SCOPE for this change: no aggregator today compares registry totals across machines. Recorded
as a named requirement for whoever builds one — any cross-machine registry comparison MUST group by
package version and registry sha before drawing a coherence conclusion, or it will report version
skew as constitution divergence. <!-- tracked: ACT-1311 -->

## 8f. Round-5 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, verdict MINOR ISSUES. No new design defects — five precision/framing findings.

**F1 — `process.env.VITEST` as the gate.** Narrowed further since the round-4 rewrite: the route no
longer accepts a path at all, only a pre-resolved `RegistryResolution` that production code never
constructs (the only producer is the test-only export, which has zero `src/` callers). The VITEST
check is now belt-and-braces over an already-closed seam rather than the seam's only guard. A
startup assertion that `VITEST` is unset in production was considered and rejected as
over-constraint: it would fail an operator legitimately running the suite against a live checkout.

**F2 — standards are now coupled to deploy cadence.** The genuinely significant tradeoff, and it
deserved naming rather than assuming. Amending the constitution now requires rebuild → publish →
rollout, and mixed-version fleets carry different constitutions until they converge. Rejected
alternatives: a **signed remote registry** (fastest propagation, but introduces a network dependency
and a fetch-time failure mode into the thing that defines correctness — and a remote the agent must
trust); a **separately versioned data package** (decouples cadence but reintroduces exactly the
skew this fixes, since code and constitution could disagree by design); a **content-addressed
artifact** (solves integrity, not distribution — something must still ship the address). Code
coupling wins because the constitution's ONLY consumer is the code that grades against it, so a
constitution its code was not built against has no meaningful use. Slower amendment propagation is
the accepted cost, and it is bounded by normal release cadence.

**F3 — phrase the runtime guarantee as artifact-pair consistency everywhere.** Done in §3 and in
the code comment. Authored-source equality is stated only as a build/test invariant.

**F4 — regex lint remains brittle for architectural enforcement.** Agreed, and the architecture has
moved to carry the weight: registry access is centralized in one module that exports no raw path,
and the production entry point takes no path argument. The lint is explicitly the RATCHET (catching
a from-scratch string rebuild), not the mechanism. Stated as such in §5.

**F5 — the deferred `builtin-manifest` defect weakens the broader claim.** Correct, and taken as a
scope bound rather than waved through. **This spec's claim is limited to the standards registry.**
It does NOT claim that instar's module-relative data assets are generally sound — the identical
defect in `src/data/builtin-manifest.json` is verified, recorded (§8.9), and unfixed. Approval of
this spec approves the registry change only. <!-- tracked: ACT-1311 -->

## 8g. Round-6 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, MINOR ISSUES. Two resolved in code, three in contract language.

**F5 — future execution layouts left as a manual obligation.** Resolved in code: a **layout matrix
test** resolves the registry from BOTH the TypeScript-source entrypoint (as vitest executes it) and
the compiled entrypoint (as production does), and asserts they see the same sha. This is the exact
class that already bit this change once, so it is now a checked fact with an obvious place for a
third layout to be added.

**F3 — the regex lint is a smoke alarm, not the mechanism.** Agreed and demoted explicitly. Resolved
in code by asserting the **import boundary** directly: no file under `src/` outside the resolver
module may reference a registry filename at all. That is the architectural guarantee; the lint
catches a from-scratch string rebuild and is labelled a ratchet, not a guard.

**F2 — no stated SLA for an urgent standard amendment.** The sharpest operational point raised so
far. Accepted propagation window: an amended standard reaches an agent **on its next instar
update**, so worst case is that agent's update cadence — there is deliberately NO faster path,
because a faster path is a remote fetch, and a constitution the agent fetches at runtime is one it
can fail to fetch. **Emergency amendment path:** a standard urgent enough to outrun release cadence
is handled as a release (patch + rollout), not as a constitution edit — the same way an urgent code
fix is. **Mixed-version reporting:** during rollout, machines legitimately hold different
constitutions; any cross-machine comparison must group by package version + registry sha (§8e F4)
before drawing a coherence conclusion.

**F4 — the 200-with-untrustworthy-body client contract.** Stated normatively: a client of
`GET /conformance/coverage` or its `/health` sub-route **MUST inspect `assessmentConfidence` /
`assessmentTrustworthy` before using any number in the body**. A 200 means "the report was produced",
never "the report is trustworthy". `enforcedRatio` is `null` — not `0` — whenever there is no
denominator, precisely so a client that ignores the contract gets an obviously-missing value rather
than a plausible wrong one.

## 8h. Round-7 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, MINOR ISSUES. Two in code, three in contract language. Findings are now
refinements rather than design defects.

**F2 — `broken-install` was overloaded.** Sharp, and it is this project's own theme turned on my
code: the round-2 catch-all mapped ANY unexpected throw to `broken-install`, which sends a reader to
reinstall when the actual cause is most likely a code regression. **Mislabelling a failure is the
same class of dishonesty as hiding one.** Resolved: the reason union is now
`broken-install | integrity-mismatch | invalid-meta | unexpected-error`. `broken-install` is reserved
for a genuinely absent required artifact; a malformed/absent meta is `invalid-meta`; an unexpected
throw is `unexpected-error` and says so. Verified live (meta removed → `invalid-meta`).

**F5 — an HTML comment is not tracking.** Correct, and it is the *Close the Loop* standard applied to
me: "untracked = abandoned". The deferred `builtin-manifest` defect is now **ACT-1311**, a real
registered action with the verified evidence and the one-line fix, committed to this project — not a
marker nobody re-surfaces. Spec markers updated to cite it.

**F3 — `unified` assumes untampered installs.** Correct qualification. §7's claim is precisely:
unified **for built and published artifacts**. A locally-tampered install can diverge undetected,
because artifact-pair consistency is not tamper resistance (§3). Fleet views must therefore group by
actual `registry.sha256`, not package version alone — strengthening §8e F4 from "version + sha" to
"**sha is the authoritative key**; version is context".

**F4 — `src/data` as a gitignored test dependency is a maintenance trap for new test entrypoints.**
Accepted. The single preparation command is `npm run build` (the generator cannot bootstrap itself —
it imports the shared parser from `dist/`). Any new test exercising the PRODUCTION resolver path must
depend on that, not on incidental generation by another file; the layout-matrix test (§8g F5) is
where a new entrypoint gets proven.

## 8i. Round-8 cross-model findings and their resolutions

`codex-cli:gpt-5.5`, MINOR ISSUES.

**F5 — length obscured the normative design.** Correct and acted on: **§0 Current normative
contract** now sits at the top with the final API, failure reasons, endpoint behaviour, client
contract, build requirement and scope bound in one table. The review history stays, below, as
provenance rather than as the thing a new implementer must excavate.

**F3 — "unreachable" overclaimed.** Right, and the same overclaiming reflex as the integrity
language in round 2. Softened to what is true: one shared parser MINIMIZES skew and the layouts are
tested; a stale artifact or parser nondeterminism could still yield a confusing count with a matching
sha — which is exactly why the count is diagnostic and can never invalidate.

**F4 — where the sha is exposed.** Every registry-derived report already carries `registry.sha256`
(and path, bytes, families, canary) in the `registry` provenance block on `GET /conformance/coverage`
and its `/health` sub-route. Stated in §0 so fleet tooling knows to key on it.

**F2 — the test-only export still sits on the production module surface.** Narrowed as far as is
useful: it is separately named, has zero `src/` callers (asserted), and the production entry point
cannot take a path. Moving it to a test-utilities module was considered and rejected — the tests
import from `src/` directly throughout this repo, so it would relocate the symbol without changing
reachability, while adding a second module that also knows registry internals.

## 8j. Round-9 cross-model findings and their resolutions

`codex-cli:gpt-5.5` — *"No serious architectural objection… deterministic packaging and integrity
checks, not LLM authority."* Findings are refinements.

**F4 — safety depended on every client remembering the contract.** The strongest remaining point,
and a well-known real-world failure mode. Resolved in code: the health response now carries a
**top-level `usable: boolean`**, so a client that inspects nothing else still gets the state
machine-readably rather than a 200 that looks fine.

**F3 — the test-only export is a package-public affordance, not merely repo-local.** Correct
distinction. "Zero `src/` callers" is a repo assertion; nothing stops an external importer.
Documented honestly as **public-but-unsupported** rather than claimed test-only: it is exported from
the same module, it is named to make misuse self-evident, and no supported instar surface calls it.
Restricting it via `package.json` `exports` is a package-wide change this spec does not make.

**F2 — should `src/data` ship at all?** It does today (via the existing `files` entry) and both
copies are byte-identical, so a published-source entrypoint resolves correctly either way. Excluding
it would save ~248 KB at the cost of breaking any consumer executing from source. Kept, named as a
cost in §2.1.

## 8k. Rounds 10-15 — recorded at summary level

Rounds 1-9 above are captured finding-by-finding. Rounds 10-15 were captured differently: their
findings were folded into the spec's normative sections as inline `(round-N finding)` annotations
rather than written up here.

**Those annotations were removed on 2026-07-28**, and this section records what they marked so the
provenance is not simply lost. The RULES they produced are unchanged and remain in the spec; only
their round labels moved here.

| round | what it produced |
|---|---|
| 10, 11, 12 | The `coverageState` single-field enum. Raised in three independent rounds and declined twice before being acted on, under a recorded three-round bar — the objection that an enum was a breaking change did not survive the non-breaking form (all four booleans retained, the enum derived from the same expression). |
| 11 | Three separate additions: the refusal PREDICATE named explicitly (`holdsAuthoredConstitution`, three required markers, evaluated before the target's existence); what happens to an operator's OWN edits (overwritten deliberately, and the backup is not a safety net for it); and the `statSync` / fail-closed treatment of an unreadable directory. |
| 13 | The `coverageState` LIFECYCLE — the enum is authoritative and the four booleans are compatibility-only from that point, because a transitional shape that is never governed becomes a permanent second contract. Also the section-classification banner. |
| 13, 14, 15 | What `registryCurrent` does NOT promise, stated beside the claim rather than only in §9/§12 — three consecutive rounds objected that `current` reads stronger than the mechanism supports, and a caveat a reader meets after the guarantee is one they meet after the decision. |

**Why the annotations were removed.** A spec that carries its own review provenance inside its
normative sections grows its reviewable surface every round, and a diligent reviewer will always find
something to sharpen on a larger surface — so the loop cannot terminate for that document shape. This
spec ran fifteen rounds without converging; a sibling spec ran ten the same day and hit the same wall
for the same reason. The separation is the fix: **the spec states the rule, this file says where the
rule came from.**

## 8l. How `coverageState` came to exist — the three-round bar

Moved out of the spec's §0 contract table on 2026-07-28, because it is the story of a decision rather
than the decision itself.

The single-field enum was raised in **three independent review rounds** (10, 11, 12) and **declined
twice** before being acted on, under a recorded three-round bar. The objection to the first two
proposals was that an enum would be a breaking change to the client contract — a fair objection to
the form proposed at the time.

What survived is the NON-BREAKING form: all four booleans retained, the enum derived from the same
three values inside the same expression. That form does not carry the objection, which is why it was
accepted on the third raising rather than the first.

The problem it solves, stated once: four booleans are a state machine that clients misuse. They read
`usable` or `assessmentTrustworthy` and miss `registryCurrent` / `guardsAnalyzable` — which is the
exact failure the extra booleans were added to prevent, reproduced one level up.

**Round 13 then made a fair follow-on objection:** retaining the booleans *indefinitely* keeps the
misuse surface alive, and a transitional shape that is never governed is just a permanent second
contract. Hence the lifecycle now stated in §0 — compatibility-only, not extended, removal tracked as
its own breaking change.
