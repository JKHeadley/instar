---
title: Dev-Agent Dark-Gate Enforcement — deliberate-classification guard + cartographer conformance
status: draft
parent-principle: "Structure beats Willpower"
tags: [side-effects]
author: echo
created: 2026-06-10
eli16-overview: dev-agent-dark-gate-enforcement.eli16.md
relates_to:
  - DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC.md
  - STANDARDS-REGISTRY.md (standard_development_agent_dark_feature_gate)
  - CARTOGRAPHER-DOC-FRESHNESS.md
  - CARTOGRAPHER-CONFORMANCE-AUDIT.md
  - CARTOGRAPHER-SUBTREE-NAV.md
review-convergence: "2026-06-10T21:26:30.795Z"
review-iterations: 3
review-completed-at: "2026-06-10T21:26:30.795Z"
review-report: "docs/specs/reports/dev-agent-dark-gate-enforcement-convergence.md"
cross-model-review: "skipped-abbreviated"
cross-model-review-reason: "external CLIs (codex/gemini/grok) unavailable on host this session; 5 internal reviewers incl. mandatory lessons-aware ran every round"
approved: true
approved-by: "Justin (topic 22726) — explicit greenlight 'yes, lets do what we can to enforce the disabled:false for developer agents'; approval model B (agent applies approved on converged spec, operator merge is the gate)"
approved-at: "2026-06-10T21:26:30Z"
---

# Dev-Agent Dark-Gate Enforcement

## ELI16 — One deliberate choice per dark feature, enforced; cartographer's zero-cost surfaces dogfood live on dev agents; the one cost-bearing surface stays an explicit opt-in.

## Why this exists (grounded requirement)

Justin, 2026-06-10, topic 22726 — after noticing the just-shipped cartographer
features were OFF even on Echo (a development agent):

> "this is not just an 'Echo' issue. The 'default: enabled' for new features
> should be the case for ALL 'developer' agents … obviously it didn't get
> encoded/enforced."

And, correcting a bad framing of mine in the same thread:

> "there's no difference between sending code to an 'outside' model like Codex
> than sending it to you. This seems silly."

Two true things:

1. **The dev-agent dark-gate standard already exists and is enforced** —
   `resolveDevAgentGate` (`src/core/devAgentGate.ts`), the `DEV_GATED_FEATURES`
   registry + both-sides wiring test, and `scripts/lint-dev-agent-dark-gate.js`
   (born from PR #1001). My earlier claim that it was "wired to nothing" was
   wrong — I grepped a stale branch.

2. **The guard has a hole, and cartographer fell through it.** The lint's
   assertion B only fires when a `ConfigDefaults` block carries a comment
   *referencing* the gate convention. A feature that hardcodes `enabled: false`
   with no such marker — exactly the cartographer specs (#2/#3/#5) — is invisible
   to the guard. It shipped dark for EVERYONE, dev agents included, no CI failure.
   The lint can't tell *"deliberately off for everyone"* (the destructive
   `mcpProcessReaper`) from *"forgot to opt in"* (cartographer). That is the hole.

### The egress correction → decouple privacy from cost (the load-bearing design decision)

I had gated cartographer's summary-authoring behind a separate
`egressAcknowledged` consent switch framed as "sending source to codex is a
privacy danger." Justin is right that the *privacy* framing is incoherent: the
agent sends the operator's source to an outside model (Anthropic) every turn by
design; a second provider seeing it is a trust *preference*, not a novel
boundary. **So the privacy gate goes.**

But round-1 convergence (all five reviewers) caught that `egressAcknowledged` was
silently doing a SECOND job: it was the only per-feature consent for an
**ongoing-cost** background process — the freshness sweep makes cadenced
off-Claude (codex) calls that bill a third-party account. Collapsing it into the
dev-gate would **auto-arm recurring third-party spend on every dev agent at once**
the moment they update — precisely the P19 "no auto-armed background loop /
rollout blast radius" mistake (earned from the #867 live-tail spiral and the
listSessions / reaper-kill hot-loops).

**Resolution — separate the two axes the old flag conflated:**

| Surface | Egress? | Ongoing cost? | Default on a DEV agent | Default on the fleet |
|---|---|---|---|---|
| doc-tree / `GET /cartographer/*` read, subtree navigate | local-only, **zero** | none | **LIVE** (dev-gated) | dark |
| conformance-coverage audit (deterministic core) | local-only, **zero** | none | **LIVE** (dev-gated) | dark |
| **freshness sweep** (authors summaries via codex) | yes | **yes (off-Claude spend)** | **OFF — explicit one-line opt-in** | dark |
| llmEnrichment / llmRerank | n/a — **unwired stubs** | none | OFF (excluded: no pipeline) | OFF |

The zero-cost read surfaces dogfood live on dev agents automatically (Justin's
actual complaint — the bulk of cartographer was dark on Echo). The **one**
cost-bearing surface (the sweep) stays an explicit opt-in EVEN on a dev agent —
not because of privacy (that gate is gone) but because auto-arming recurring
third-party spend across an agent class is a P19 blast-radius decision, not a
per-pass-bounds decision. Because the sweep is now an explicit single honest flag
(`freshnessSweep.enabled: true`), the redundant `egressAcknowledged` second gate
is removed entirely (Justin's "silly" — correct, once cost is handled by the
explicit opt-in). The off-Claude **routing probe stays** (the sweep refuses to
author on Claude) — that guard is about cost, and cost still matters.

> **Open decision #2 is hereby RESOLVED in-spec** (per P3/P10 — decided here, in
> this change): the sweep is an explicit opt-in even on dev agents. If
> Justin wants it auto-armed on dev agents too, that is a one-line change (move
> `freshnessSweep.enabled` into `DEV_GATED_FEATURES`), but this spec ships the
> safer default.

## The standard being enforced (unchanged)

```ts
const enabled = cfg?.enabled ?? !!config.developmentAgent;  // resolveDevAgentGate
```

A dev-gated dark feature OMITS `enabled`; the runtime resolves it through
`resolveDevAgentGate`. Live on `developmentAgent: true`, dark on the fleet,
explicit `enabled` always wins.

## Slice A — Cartographer conformance (dogfood the zero-cost surfaces)

**A1. Gate the umbrella.** `ConfigDefaults.ts` cartographer block: remove
`enabled: false` (OMIT). `src/commands/server.ts` (~L8415): replace
`(config as …).cartographer?.enabled ?? false` with
`resolveDevAgentGate(config.cartographer?.enabled, config)`. Register
`cartographer.enabled` in `DEV_GATED_FEATURES`.

**A2. Gate the conformance audit (zero-cost deterministic core).** OMIT
`cartographer.conformanceAudit.enabled` from defaults; register it. **Fix the
route gate:** `src/server/routes.ts:~4303` currently `if (cfg?.enabled !== true)
… 503`. A strict `!== true` returns 503 on a dev agent (undefined !== true) even
after registration — a wiring-test-green / feature-dark divergence. Change every
such cartographer gate site to `if (!resolveDevAgentGate(cfg?.enabled, ctx.config))`.
Enumerate ALL strict `=== true` / `!== true` cartographer enable checks (audit
routes.ts + server.ts) and convert each; the build must grep-verify none remain.

**A3. The freshness sweep stays an explicit opt-in (NOT dev-gated).**
`freshnessSweep.enabled` keeps its `enabled: false` default and is placed in
`DARK_GATE_EXCLUSIONS` (category `cost-bearing`). **Remove the
`&& fsCfg?.egressAcknowledged` term** from the single construction site
(`server.ts:8435`) so the sweep needs only the one honest `enabled: true`. The
off-Claude routing probe and all per-pass bounds (`maxNodesPerPass`,
`maxCentsPerPass`, CPU-pressure yield, lease-gating, breaker) are UNCHANGED.

**A4. Exclude the unwired stubs.** `conformanceAudit.llmEnrichment.enabled` and
`subtreeNav.llmRerank.enabled` have **no runtime consumer** (confirmed: the
shipped auditor/navigator make no LLM calls). Do NOT register them — a gate over
a dead flag asserts nonexistent behavior. Place both in `DARK_GATE_EXCLUSIONS`
(category `structural-stub`, reason "no LLM pipeline wired").

## Slice B — Close the hole (deliberate-classification guard)

Every `enabled: false` in `ConfigDefaults.ts` must be a DECLARED choice.

**B1. Exclusion registry with a quality bar.** Add `DARK_GATE_EXCLUSIONS` to
`src/core/devGatedFeatures.ts`: `{ configPath, category, reason }[]`, where
`category` is a CLOSED enum — `destructive` | `optional-integration` |
`cost-bearing` | `structural-stub` | `deliberate-fleet-default` — and `reason` is
free text. The lint REJECTS an entry with an unknown category or a reason shorter
than 12 non-whitespace chars (defeats `reason:'x'` placeholders).

**B2. Lint assertion C — no unclassified dark default.** For every
`enabled: false` in `ConfigDefaults.ts`, the enclosing feature's config path must
be EITHER registered in `DEV_GATED_FEATURES` (→ surfaced as "registered but still
hardcodes false: OMIT it") OR in `DARK_GATE_EXCLUSIONS`. Neither → violation.
Retain assertions A and B.

  - **Path attribution discipline (explicit, tested, honest about its limit).**
    The brace-tracker that maps an `enabled:` line to its dotted path MUST reuse
    the existing `codeOnly()` helper so braces inside `//` comments (e.g. the
    `{ran:false}` literal at L423) and trailing-comment braces never count toward
    depth. **`codeOnly()` strips `//` line-comments only — it does NOT skip
    braces inside string/template literals** (verified: lint script L73). Rather
    than claim a coverage the helper lacks (P2 Signal-vs-Authority — the same
    honesty bar assertion C is held to), the lint adds a **loud-fail guard**: if
    any line in the `SHARED_DEFAULTS` region contains a `{` or `}` inside a
    string/template literal, the lint ERRORS ("brace-in-string in the defaults
    block can desync path attribution — split the value or extend the parser")
    instead of silently desyncing. Today zero such lines exist in the block
    region (the `${path}.${key}` template literals are after the last
    `enabled:false`), so the guard is dormant; it fires the instant the
    unhandled case is introduced.
  - **Golden-path drift canary — hand-authored, regeneration-forbidden.** A test
    asserts the resolver returns the EXACT expected dotted path for every current
    `enabled:` line. The expected `{line → dottedPath}` map is a **hand-maintained
    literal in the test file — NOT a vitest/jest snapshot artifact and NEVER
    derived from the resolver's own output** (a snapshot regenerated from the
    resolver asserts `output == output` and blesses any misattribution). A
    comment forbids regeneration-from-resolver; updating the map is a hand edit on
    a CODEOWNERS-reviewed path. This is what makes a deterministic-but-wrong
    attributor fail CI instead of passing it.

  - **Declared limitation (P2 Signal-vs-Authority — do NOT claim full closure).**
    Assertion C matches the literal `enabled: false` spelling only. A non-literal
    default (`enabled: someFlag ?? false`) evades it — the same miss named in the
    prior conformance spec's Layer-2 row. This spec **carries that miss forward
    explicitly**: C closes the literal-false hole (which is what cartographer and
    #1001 were), not the non-literal-expression hole. The lint prints this limit
    in its failure header so no future reader treats C as total coverage.

**B3. Classify the existing 21 as an auditable table.** A one-time pass sorts
every current `enabled: false` to gate-vs-exclude. Because the wiring test
*confirms* gating but cannot *validate* it (a wrongly-gated feature passes its
live-on-dev/dark-on-fleet assertions), the classification ships as a single
reviewable table (configPath, category, reason) in the PR body AND as the seeded
registries. **Safety guard (a marker denylist — limit declared, human gate is the real
backstop).** The assertion-C tests assert that any block whose body contains a
destructive/credentialed marker (`dryRun`, kill/delete verbs, a third-party
`framework`/credential key) is NOT in `DEV_GATED_FEATURES` — so a future attempt
to silently dev-gate a marker-bearing destructive feature (e.g.
`mcpProcessReaper`, which carries `dryRun: true`) trips a test, not just review.
**This is a denylist, not a structural property** (P2 — same limit class as
assertion C): a destructive feature that omits those markers (no dry-run mode, a
synonym like `simulate`/`safeMode`, or destructiveness behind a neutrally-named
flag) would NOT trip it. So the **real backstop is the human gate, named as
such**: `DEV_GATED_FEATURES` and `DARK_GATE_EXCLUSIONS` are CODEOWNERS-reviewed
paths, and every addition to `DEV_GATED_FEATURES` must carry a one-line
"non-destructive, safe-to-run-live-on-dev" justification in the entry. The lint
denylist is a tripwire over the common case, not a proof. Known excludes seeded
with reasons: `mcpProcessReaper` (destructive), the cartographer sweep + stubs
(above), and the optional integrations.

## Migration Parity (SHIPPED in this PR — P3/P10)

Existing dev agents already have `cartographer.enabled: false` on disk, so
`applyDefaults` add-missing leaves them DARK after update — the motivating case
(Echo) would not light up. A feature that only works for new agents is broken.
**Ship a scoped, one-shot migration** in `PostUpdateMigrator`:

- Runs ONLY when `config.developmentAgent === true`.
- Gated by a one-shot migration-version marker (`_instar_migrations` /
  equivalent) so it executes exactly once and can NEVER re-strip a value the
  operator later re-adds — this is the provenance discriminator (value alone
  can't distinguish a deliberate operator `false` from the old default `false`;
  the run-once marker means we only ever touch the original default, once).
- Strips a default-shaped `cartographer.enabled: false` and
  `cartographer.conformanceAudit.enabled: false` (the ZERO-COST read surfaces)
  so the gate now decides them live on the dev agent.
- **Never touches `freshnessSweep.enabled`** — the cost-bearing surface is never
  auto-armed by an update (the P19 / Migration-Parity "no surprise activation on
  update" guard; the zombie-cleanup precedent).
- Idempotent, existence-checked, records the change in `result.upgraded`.

No `generateClaudeMd` change — confirmed: the cartographer CLAUDE.md sections
already exist and describe the capability; this changes WHEN dark resolves to
live, not the capability surface. The `egressAcknowledged` neutralization is noted
in the upgrade-guide fragment as a deliberate behavior change (No Silent
Degradation: an operator who set it `false` should be told it's now inert; since
the sweep still needs explicit `enabled:true`, no surprise spend results).

## Testing (three tiers)

- **Unit:** (1) the new `cartographer.enabled` + `conformanceAudit.enabled`
  registry entries drive `devGatedFeatures-wiring.test.ts` (live-on-dev /
  dark-on-fleet auto-asserted). (2) Assertion-C tests: an unclassified
  `enabled:false` FAILS; same path added to exclusions PASSES; a registered path
  that still hardcodes `false` FAILS; an exclusion with junk/short reason or
  unknown category FAILS. (3) Golden-path drift-canary: a HAND-AUTHORED literal
  `{line → dottedPath}` map for ALL current `enabled:` blocks (NOT a vitest
  snapshot, NEVER regenerated from the resolver) — the resolver must match it.
  (3b) Brace-in-string loud-fail: a fixture with a `{`-bearing string default in
  the block region makes the lint ERROR, not silently desync. (4) Destructive-
  not-gated guard test (mcpProcessReaper stays excluded). (5) The B3 invariant —
  every current `enabled:false` is classified.
- **Integration:** with `developmentAgent:true`, `GET /cartographer/health` AND
  `GET /conformance/coverage` return **200** (not 503) through the real server
  wiring; with a fleet config both 503. Asserts the route-gate fix (A2), the live
  failure mode the strict `!== true` would have produced.
- **E2E:** production init path with `developmentAgent:true` vs fleet config —
  cartographer read routes live in the former, 503 in the latter; the sweep poller
  is NOT started in either without explicit `freshnessSweep.enabled:true` (proves
  the cost surface is not auto-armed).

## Security / adversarial (round-1 hardening folded in)

- `developmentAgent` is operator-set, runtime-read-only, not API-mutable, not
  auto-derived — the gate can't be flipped by a token holder or malicious input.
- Cost/spend can no longer be auto-armed across the dev fleet (A3): the one
  cost-bearing surface needs an explicit flag everywhere.
- The exclusion registry's value is **diffability + a category/reason quality
  bar**, not prevention — stated plainly so reviewers aren't lulled. The
  destructive-not-gated test is the structural backstop. Adding to
  `DARK_GATE_EXCLUSIONS` should be a CODEOWNERS-reviewed path.
- The lint is deterministic, parses only the one defaults file, no egress/LLM.

## Open decisions for the operator

1. **Auto-arm the sweep on dev agents too?** This spec defaults it to explicit
   opt-in even on dev agents (P19-safer). Flip = one line (move
   `freshnessSweep.enabled` to `DEV_GATED_FEATURES`). Operator's call.
