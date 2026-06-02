---
title: "Re-platform cross-model review onto the installed codex CLI (Step B of the tiered development process)"
date: 2026-06-01
author: echo
review-convergence: abbreviated-internal-2026-06-01
approved: true
approved-by: Justin
approved-via: "Telegram topic 13435 (2026-06-01) 'Approved'; abbreviated convergence (internal panel) returned MINOR ISSUES, 5 findings folded in (§2/§4/cost). External cross-model review is itself what this step builds, so its own convergence uses the internal path. Findings were refinements, not a redesign."
eli16-overview: codex-crossreview-stepB-spec.eli16.md
---

# Re-platform cross-model review onto the installed codex CLI (Step B)

> **Status:** Step B of the **Tiered Development Process** project
> (`docs/projects/tiered-dev-process/PROJECT.md`, §4 cross-model review re-platform; §6
> decisions D3/D4). This is a **Tier-2** change: it needs spec-review-convergence and
> Justin's approval before build. Convergence ran the **abbreviated internal panel** (the
> external cross-model reviewer is itself what this step *builds*, so its own convergence
> uses the internal path) on 2026-06-01; it returned MINOR ISSUES and the 5 findings (F1–F5)
> were folded into §2/§4/cost. Justin approved (Telegram topic 13435), so
> `review-convergence` and `approved: true` are now set in the frontmatter.

## Goal

The `/spec-converge` skill runs eight reviewers on every spec before `/instar-dev` may
touch instar source. Five are internal Claude subagents; **three are external
"cross-model" reviewers** (GPT-tier, Gemini-tier, Grok-tier) whose value is that they
sit *outside* the Claude family and catch shared blind spots. The skill describes those
externals as running **"via the /crossreview pattern"** (`skills/spec-converge/SKILL.md`
~line 74) — a placeholder for an API-driven swap point that was never built as a
concrete, reachable mechanism. There is no `/crossreview` skill, script, or route in the
tree (verified: `skills/` has no `*crossreview*` dir; the only `crossreview` string is
the SKILL.md prose itself).

**Step B makes the external cross-model reviewer real by routing it through the agent's
own installed `codex` CLI** — the same headless `codex exec` path instar already uses for
every other judgment call — instead of a hypothetical third-party API. codex is the
*first supported framework* in an extensible registry (gemini-cli and others land in a
later step). When **no** supported reviewer framework is installed/authed, the system
**degrades to internal-only convergence** and records a loud, machine-readable
`cross-model-review: unavailable` flag on the spec and in the convergence report. It
**never blocks** convergence, and the non-skippable lessons-aware internal reviewer always
still runs.

This is a faithful instance of the project's locked decisions **D3** (framework-native
via the detected codex CLI — the agent's own auth, no new API key, no new network
dependency) and **D4** (no-codex → internal-only + a loud unavailable flag, never a hard
stop). Justin approved D3/D4 in the project shape.

## Current behavior (what Step B modifies)

`/spec-converge` Phase 1 spawns eight reviewers in parallel and collects their findings
(`skills/spec-converge/SKILL.md` §"Phase 1"). The five internal reviewers are real Claude
subagents driven by the prompts in `skills/spec-converge/templates/reviewer-*.md`. The
three externals share **one** prompt, `reviewer-cross-model.md`, and are described as
running "via the /crossreview pattern" — but that pattern has no implementation: nothing
in the tree actually feeds the spec to a non-Claude model. In practice the external pass
is either skipped or hand-waved. Step B replaces the hand-wave with a grounded mechanism.

Two things are explicitly **out of scope and untouched**:

- **The internal reviewers** (security, scalability, adversarial, integration,
  lessons-aware) — they keep running exactly as today.
- **The Standards-Conformance Gate** (`POST /spec/conformance-check`) — the code-backed
  constitutional pass auto-invoked alongside the eight. Step B does not change it.

`src/core/ConvergenceChecker.ts` / `src/templates/scripts/convergence-check.sh` are a
**separate** heuristic content-quality gate (regex anti-pattern scan, no LLM, no
reviewers). They are unrelated to the reviewer panel and are **not** modified by Step B.
(They are listed in the grounding set only to confirm the boundary: the "convergence
machinery" that Step B touches is the *reviewer orchestration in the skill*, not the
content-quality regex gate.)

## Grounded mechanism — headless codex invocation (the crux)

instar **already runs codex headlessly** for every non-Claude judgment call, via
`CodexCliIntelligenceProvider.evaluate()`
(`src/core/CodexCliIntelligenceProvider.ts:96-176`). The exact command it builds is:

```
codex exec \
  --model <resolved-model> \
  --sandbox read-only \
  --cd <empty-mkdtemp-scratch-dir> \
  -c project_doc_max_bytes=0 \
  --skip-git-repo-check \
  "<prompt>"
```

with stdin closed (`child.stdin?.end()`) and the child env built by
`buildCodexChildEnv()` (allowlist, never `{...process.env}` — so `OPENAI_API_KEY` can't
leak in and silently bill the wrong account; `src/core/CodexCliIntelligenceProvider.ts:143`).
This is `codex`'s genuine non-interactive one-shot mode (`codex exec` — the same mode the
project's Step-A spec and `CodexCliIntelligenceProvider` doc-comment name). **codex has a
clean headless one-shot mode; we do not need to synthesize one.**

The flags matter and Step B reuses every one of them deliberately:

- `--sandbox read-only` — a reviewer reads and judges; it never writes. (Default in the
  provider.)
- `--cd <empty scratch dir>` + `-c project_doc_max_bytes=0` — the scratch dir is created
  with `mkdtempSync` (mode 0700, unguessable suffix; `resolveIntelligenceScratchDir`,
  lines 58-62). This is the **clean-notepad** guarantee: running `codex exec` in the
  agent's project dir would load the ~26 KB `AGENTS.md` identity AND fire the project's
  `.codex/hooks.json` (session_start / user_prompt_submit / stop) on every call — turning
  a review into a full agent boot (the 2026-05-26 ~1,550-spawns/day bug, lines 51-56).
  A reviewer must judge the spec **as a neutral GPT-tier model**, not as a booted copy of
  the agent — so the empty, hook-free, identity-free scratch dir is exactly right for
  cross-model review.
- `--skip-git-repo-check` — codex refuses to run when `--cd` points at a non-git dir; the
  scratch dir isn't a repo, so this is required (lines 116-124).

**Model selection (GPT-tier).** `resolveCliModelFlag(options.model)`
(`src/providers/adapters/openai-codex/models.ts`) maps the canonical tier
`'capable'` → **`gpt-5.5`** (newest frontier reasoning model, working on the ChatGPT
subscription account; the `fast`/`balanced` tiers map to `gpt-5.2` / `gpt-5.4-mini`). A
cross-model spec review is a heavyweight reasoning task, so Step B requests the
**`capable`** tier → `gpt-5.5`. (The tier is the knob; the concrete model id stays owned
by `models.ts`, so a future model bump needs no Step-B change.)

**Auth = the agent's own codex auth, no new credential.** D3 is satisfied by reusing the
provider: no API key is introduced, the call rides the agent's existing
`codex login` (ChatGPT subscription OAuth in `~/.codex/auth.json`), and the
allowlist-built env keeps `OPENAI_API_KEY` *out*.

### Why route through the existing provider, not a new spawn

The crux decision: Step B's invocation goes through
**`buildIntelligenceProvider({ framework: 'codex-cli' })`**
(`src/core/intelligenceProviderFactory.ts:59`) → a wrapped
`CodexCliIntelligenceProvider`, NOT a bespoke `codex exec` spawn written in the skill.
Reasons:

1. **The hardening is already there and is non-obvious.** The scratch-dir clean-notepad,
   the env allowlist, the stdin-close, the `--skip-git-repo-check`, the 30s timeout — each
   encodes a real past failure. A hand-rolled spawn in the skill would re-litigate every
   one of them and silently regress (e.g. re-introduce the AGENTS.md-boot spam).
2. **The account-global circuit breaker is free.** Every provider the factory hands out is
   wrapped with `CircuitBreakingIntelligenceProvider`
   (`intelligenceProviderFactory.ts:64-67`), so a rate-limited codex review degrades the
   same way every other instar LLM call does — no new fail-open path.
3. **`IntelligenceOptions.timeoutMs`** is already honored per-call
   (`CodexCliIntelligenceProvider.ts:151`), giving Step B a clean place to set the
   reviewer timeout.

The **only** new code is (a) a thin **codex cross-model reviewer driver** that builds the
reviewer prompt + spec + referenced context into one string and calls
`provider.evaluate(prompt, { model: 'capable', timeoutMs })`, parses the structured
finding list out of the returned text, and (b) the **detection + registry + fallback-flag**
plumbing below.

## Design

### 1. Detection — is a supported reviewer framework installed + authed?

A pure function `detectCrossModelReviewer()` returns
`{ available: boolean, framework?: 'codex-cli', model?: string, reason?: string }`:

- **Binary present?** `detectCodexPath()` (`src/core/Config.ts:282`, which wraps
  `detectFrameworkBinary('codex')` — PATH + asdf + nvm shim resolution, login-shell-safe).
  `null` → not installed.
- **Authed?** Reuse the canonical OAuth probe shape already used by the codex smoketest
  (`src/providers/adapters/openai-codex/_smoketest.ts:22-36`): read
  `${CODEX_HOME || ~/.codex}/auth.json`; **authed** iff `tokens.access_token` is present
  (subscription OAuth — D3's required auth shape). A missing/unreadable/malformed file →
  not authed.
- **Spec-12 Rule 1 (API-key forbidden).** Run `validateRule1()`
  (`src/providers/adapters/openai-codex/credentials.ts:132`). If it reports
  `CODEX_AUTH_APIKEY_DETECTED` (env `OPENAI_API_KEY` set, or `auth.json` is API-key shape),
  the reviewer is treated as **not available** with reason
  `codex-auth-apikey-forbidden` — instar's policy is subscription-OAuth only, and we must
  not run a cross-model review on a credential shape the rest of the codebase refuses. This
  reuses existing policy rather than inventing a new one.

`available: true` requires **all three**: binary found, OAuth `access_token` present,
Rule-1 clean. Any miss → `available: false` with a specific `reason`
(`codex-not-installed` | `codex-not-authed` | `codex-auth-apikey-forbidden`).

**Where the check lives.** `detectCrossModelReviewer()` is a pure TS function exported
from a new module `src/core/crossModelReviewer.ts` (unit-testable with injected
`{ codexPathDetected, authJsonPath, env }`, no real spawns). The **converge skill calls it
at Phase 1** to decide whether the external pass runs or the fallback flag is set. It is
*signal-only* detection — it never throws and never blocks; a `false` simply routes to §4.

### 2. Invocation — feed the reviewer prompt + spec + context to codex headlessly

When `detectCrossModelReviewer()` returns `available: true`, the skill runs the **codex
cross-model reviewer driver**:

1. **Build the prompt.** Compose one string: the contents of
   `skills/spec-converge/templates/reviewer-cross-model.md` (with `{SPEC_PATH}`
   substituted) + the full spec markdown + the **referenced architectural context** the
   spec names (the docs the spec links — same set the internal reviewers receive). codex
   runs in an empty scratch dir with **no filesystem access to the repo** (read-only
   sandbox, foreign cwd), so the context must be **inlined into the prompt**, not left as
   on-disk paths for codex to open. The driver reads each referenced doc from the repo
   (instar-side, before the spawn) and concatenates it under a clear `--- CONTEXT: <path>
   ---` header.

   **The reviewer template matches the inlined reality (F3).** `reviewer-cross-model.md`
   does **not** tell the model to "read the spec at `{SPEC_PATH}`" or to open any file —
   codex has no repo access, so a file-reading instruction would be a dead end that wastes
   a turn or invites a hallucinated read. Instead the template states that the spec and all
   context are **inlined below** (under the `--- SPEC UNDER REVIEW: ... ---` and
   `--- CONTEXT: <path> ---` markers), and that the model must review only what is inlined.
   The template also drops the stale "GPT / Gemini / Grok" three-phantom-model framing: Step
   B runs **one** cross-model pass through the first available supported framework (codex
   today), so the prompt frames a single non-Claude GPT-tier reviewer, not three. The
   `{SPEC_PATH}` token is retained purely as a label so the reviewer can cite the spec by
   path; `assembleReviewerPrompt()` substitutes it and then inlines the spec body, so there
   is no contradictory "open the file" instruction reaching codex.

   **A per-call context budget** (default 60 KB total, tunable) bounds the prompt; if
   referenced docs exceed it, the driver includes the spec in full + as much context as fits
   and notes the truncation in the prompt so the reviewer knows its view was partial (a
   partial review is still signal; a silently-truncated one is a trap).

   **Truncation is deterministic and names what it dropped (F4).** When the budget can't
   hold every referenced doc, the drop is **not** "whatever happened to come last in an
   arbitrary order." `assembleReviewerPrompt()` first orders the referenced docs by a fixed
   priority (`orderContextDeterministically`): the constitutional / lessons docs
   (`signal-vs-authority`, `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS`, `STANDARDS-REGISTRY`,
   `integrated-being`) sort **first** — they are the highest-value context for a reviewer and
   what the lessons-aware internal reviewer reads — and the remaining docs keep the
   **spec-declared link order** (the order the caller passed them, which is the order they
   appear in the spec). A stable sort means the same spec + same docs **always** drop the
   same docs (a review is reproducible). And the truncation note **names the affected docs**
   — which doc was cut mid-document (`PARTIAL`) and which were `FULLY OMITTED` — so the
   reviewer knows exactly which context it could not see, not merely that "something" was
   cut.
2. **Invoke.** `provider.evaluate(prompt, { model: 'capable', timeoutMs: REVIEW_TIMEOUT_MS })`.
   `REVIEW_TIMEOUT_MS` default **120_000** (a reasoning review of a full spec is far heavier
   than the 30s judgment-call default; the value is a tunable constant). The provider's
   own `codex exec` command (above) is reused verbatim; the driver passes only the prompt
   and options.
3. **Parse.** The reviewer prompt already mandates a bounded, structured shape:
   `Verdict: CLEAN | MINOR ISSUES | SERIOUS ISSUES` + a findings list with section refs
   (`reviewer-cross-model.md` lines 23-26). The driver extracts the verdict line and the
   findings into the same `{ reviewer, verdict, findings[] }` record shape the internal
   reviewers produce, tagged `reviewer: 'cross-model:codex-cli:gpt-5.5'`. If the verdict
   line is unparseable, the finding set is captured as one raw "unstructured external
   review — read manually" finding (never dropped).

**Failure handling (every path fails toward internal-only, never toward a stall):**

- **Timeout** (`execFile` timeout fires) → the provider rejects; the driver records a
  `cross-model-review: degraded` note (reason `timeout`) and the round proceeds on the
  internal reviewers + whatever externals succeeded. Not a block.
- **Non-zero exit / CLI error** → the provider rejects with the stderr slice (it already
  slices 600 chars for the rate-limit classifier); the driver records `degraded` with the
  reason. Not a block.
- **Circuit breaker open** (account rate-limited) → the wrapped provider surfaces it; the
  driver records `degraded` (reason `rate-limited`) and proceeds. This is the **one
  intentional fail-open**: a rate-limited cross-model review must not stall spec review,
  consistent with how every other instar LLM gate behaves under load.
- **Empty/blank stdout** → treated as an unparseable review → one raw finding, not silent
  success.

The distinction between `unavailable` (§4 — no supported framework at all) and `degraded`
(framework present but this call failed) is recorded explicitly so the report can tell the
user "you have no cross-model reviewer" apart from "your cross-model reviewer was rate-limited
this round."

### 3. Supported-reviewer registry — the extension point

codex is the **first** supported framework; the registry is where gemini-cli and others
plug in later. It is a small static table in `src/core/crossModelReviewer.ts`:

```ts
interface SupportedReviewerFramework {
  id: 'codex-cli';                       // extend the union to add a framework
  detect(): { available: boolean; model?: string; reason?: string };
  // builds the prompt + calls the framework's IntelligenceProvider; returns findings
  review(args: { promptText: string; timeoutMs: number }): Promise<ReviewerResult>;
}

const SUPPORTED_REVIEWER_FRAMEWORKS: SupportedReviewerFramework[] = [ codexReviewer ];
```

`detectCrossModelReviewer()` walks the registry in order and returns the **first**
available framework (codex today; the order is the preference order). Adding a framework
is: (a) extend the `id` union, (b) push a new entry that wires that framework's already-
existing `IntelligenceProvider` (the factory already supports `framework: 'codex-cli'` and
is built to extend — `intelligenceProviderFactory.ts:28` `IntelligenceFramework` union).
**No skill change** is needed to add a framework — the registry is the single seam. This
mirrors the established instar single-funnel pattern (one table, one detection walk).

The registry lives in `src/` (not the skill) deliberately: detection + invocation are
real code with security invariants (the auth probe, the env allowlist), and code is
unit-testable and migration-trackable in a way a skill prompt is not (**Structure >
Willpower**). The skill *calls* the registry; it does not *contain* it.

### 4. No-codex fallback (Justin-approved D4) — internal-only + loud flag, never block

When `detectCrossModelReviewer()` returns `available: false` (no supported framework
installed/authed), convergence proceeds **internal-only**:

- The five internal reviewers + the Standards-Conformance Gate run **exactly as today**.
  The **lessons-aware reviewer is non-skippable** — it runs in every mode (it is the
  structural defense against the spec-converge-pre-auth-circular failure; SKILL.md §"The
  lessons-aware reviewer is not optional").
- A **loud, machine-readable flag** is recorded in two places:
  1. **On the spec frontmatter**, written alongside the convergence tag by
     `write-convergence-tag.mjs`: `cross-model-review: unavailable` (+
     `cross-model-review-reason: "<reason>"`). When a supported reviewer DID run, the same
     field is written `cross-model-review: codex-cli:gpt-5.5` so the spec self-documents
     which external pass it received (or didn't).
  2. **In the convergence report** (`docs/specs/reports/<slug>-convergence.md`): a
     dedicated, can't-miss banner section — `## ⚠ Cross-model review: UNAVAILABLE` — stating
     no external (non-Claude) reviewer was installed/authed, that convergence ran on
     internal Claude reviewers + the constitutional gate only, the specific reason, and the
     one-line remediation (`codex login`, or install `@openai/codex`). The user reads this
     before applying `approved: true`, so the reduced-assurance state is an **informed**
     choice, not a silent one.
- **Convergence still completes and is still taggable.** D4 is explicit: never block.
  `unavailable` is a disclosed reduction in assurance, not a gate.

**Every non-ran state carries the loud banner (F1).** The `cross-model-review:` field has
several non-`ran` states (`unavailable`, `degraded`, `degraded-all-rounds`,
`skipped-abbreviated`), and **none of them may read as a clean pass.** The report banner
(SKILL.md Phase 4) renders the loud `⚠` marker for **all** of them — including
`skipped-abbreviated` (the author chose the fast path) — exactly as loudly as `unavailable`.
The clean `## Cross-model review: codex-cli:<model>` form (no `⚠`) is reserved for the one
state where a real external pass actually ran. A deliberately-skipped or all-degraded
external review is a real reduction in assurance and must be as visible to the approving
human as a missing reviewer — never a quiet footnote.

A `degraded` external call (§2 — codex present but this round's call failed) is treated as
a *partial* cross-model pass for that round: the per-round flag reads
`cross-model-review: codex-cli:gpt-5.5 (degraded: <reason>)`. It does not collapse to
`unavailable` (the framework IS there).

**Spec-level aggregation across rounds — `degraded-all-rounds` (F2).** Convergence runs
**multiple rounds**, but the spec gets exactly **one** final `cross-model-review:` value.
Each round produces a per-round `ReviewerResult` (`ok` / `degraded` / `unavailable`); the
skill tracks the per-round outcomes and computes the final flag via
`aggregateRoundOutcomes(rounds, { skippedAbbreviated })` (exported from
`crossModelReviewer.ts`), per these rules:

- **`codex-cli:<model>`** — **any** round got a successful external pass. One genuine outside
  opinion is enough to say the spec received real cross-model review (the freshest successful
  round's flag is used).
- **`degraded-all-rounds`** — a framework was present in the rounds but **zero** rounds
  succeeded (every attempt degraded). This is treated **as loud as `unavailable`**: the spec
  converged having **never once received a real external opinion**, and that fact must surface
  at the **spec level** (the banner + the frontmatter flag) — not hide inside per-round
  degraded notes that, read individually, make it look like the review "tried."
- **`unavailable`** — no supported framework was ever available across the rounds.
- **`skipped-abbreviated`** — the author opted out of the external pass entirely.

The motivation for `degraded-all-rounds` is precisely the trap it closes: a spec that
degraded on every round looks, from per-round notes alone, like it attempted cross-model
review — but it converged with the SAME assurance as one that had no reviewer at all. The
spec-level aggregate makes "converged with no real external opinion" impossible to miss.

### 5. How it threads into spec-converge

The change to `skills/spec-converge/SKILL.md` is surgical, at the **Phase 1 external
reviewer step** (~line 74) and Phase 5 (tag) / Phase 4 (report):

- **Phase 1.** Replace the prose "External reviewers (cross-model, via the /crossreview
  pattern): GPT-tier / Gemini-tier / Grok-tier" with: *call
  `detectCrossModelReviewer()`. If available, run the codex cross-model reviewer driver
  (§2) as the external pass and fold its findings in alongside the internal reviewers'. If
  unavailable, skip the external pass, set the fallback flag (§4), and continue.* The
  GPT/Gemini/Grok "three externals" framing collapses to **one cross-model pass through the
  first available supported framework** — which is the honest mechanism (one installed CLI,
  not three phantom API models).
- **Internal reviewers + Standards-Conformance Gate: unchanged.** All five internal
  reviewers and the auto-invoked `POST /spec/conformance-check` still run on every round in
  every mode. The lessons-aware reviewer remains non-skippable.
- **Phase 4 (report).** Add the cross-model status banner (§4) — `codex-cli:<model>`,
  `degraded`, `degraded-all-rounds`, `UNAVAILABLE`, or `SKIPPED` — so the human handoff
  always states the external-review posture. **Every non-ran state carries the loud `⚠`
  marker (F1)**; only the real-pass `codex-cli:<model>` form is unmarked.
- **Phase 5 (tag).** `write-convergence-tag.mjs` writes the **aggregated, spec-level**
  `cross-model-review:` (+ `-reason`) frontmatter field — the `aggregateRoundOutcomes`
  result across all rounds (F2), not a single round's status. This is **additive** to the
  existing tag write (it already rewrites frontmatter; we add one or two lines), and it does
  **not** change the
  convergence/approval gate logic in `scripts/instar-dev-precommit.js` — that gate still
  keys only on `review-convergence` + `approved: true` (`instar-dev-precommit.js:417-435`).
  The cross-model flag is **disclosure, not a gate**: an `unavailable` spec can still be
  approved (D4). Whether `unavailable` should ever *raise* the tier or require an extra
  approval acknowledgment is **out of scope here** (a policy question for a later step;
  noted in Out of Scope).

The "abbreviated convergence" mode (SKILL.md §"Anti-patterns": externals may be skipped to
save cost, lessons-aware must still run) is preserved and made precise: abbreviated mode =
`cross-model-review: skipped-abbreviated` (distinct from `unavailable`) — the framework may
be present but the author chose the fast path; the flag records that choice honestly.

## Testing (3-tier)

### Unit (`tests/unit/`)

- **Detection logic** (`detectCrossModelReviewer`, injected inputs — no real spawn):
  - binary missing → `{ available: false, reason: 'codex-not-installed' }`.
  - binary present + `auth.json` with `tokens.access_token` → `{ available: true,
    framework: 'codex-cli', model: 'gpt-5.5' }`.
  - binary present + `auth.json` missing/unreadable/malformed → `not-authed`.
  - binary present + `OPENAI_API_KEY` in env → `codex-auth-apikey-forbidden`
    (Rule-1 reuse).
  - binary present + `auth.json` API-key shape (`sk-`) → `codex-auth-apikey-forbidden`.
- **Registry**: walk returns the first available framework; with codex unavailable and no
  other entry, returns `{ available: false }`; adding a second stub framework after codex
  is selected only when codex is unavailable (order = preference).
- **Fallback-flag emission**: `write-convergence-tag.mjs` writes
  `cross-model-review: unavailable` + `-reason` when passed the unavailable state, and
  `cross-model-review: codex-cli:gpt-5.5` when passed the available state; idempotent
  (re-run strips/rewrites the field, like the existing review-* fields, lines 110-120).
- **Driver parse**: a well-formed reviewer reply (`Verdict: SERIOUS ISSUES` + findings)
  parses into the structured record; an unparseable reply yields exactly one raw
  "unstructured external review" finding (never zero, never thrown).
- **Spec-level aggregation across rounds (F2)** — `aggregateRoundOutcomes`: any successful
  round → the clean `codex-cli:<model>` flag (last success wins); a framework present every
  round but zero successes → `degraded-all-rounds` (carries the last degraded reason); all
  rounds unavailable → `unavailable` (NOT `degraded-all-rounds`); `skippedAbbreviated` wins
  over everything; empty rounds → `unavailable`. Plus `buildCrossModelFlag('degraded-all-rounds')`
  emits the exact frontmatter string.
- **Deterministic context truncation (F4)** — `assembleReviewerPrompt` /
  `orderContextDeterministically`: constitutional/lessons docs (`signal-vs-authority`,
  `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS`, …) are kept FIRST regardless of caller order; the
  truncation note **names** the partial doc and the fully-omitted docs (not just
  "truncated"); identical inputs produce byte-identical prompts (reproducible); the ordering
  function is pure (does not mutate its input).

### Integration (`tests/integration/`)

- **Convergence flow with codex present**: stub the `IntelligenceProvider.evaluate` to
  return a canned structured review; assert the convergence round folds the external
  findings in AND the report banner reads `codex-cli:gpt-5.5` AND the spec frontmatter
  gets `cross-model-review: codex-cli:gpt-5.5`. (Provider is stubbed — no real codex spawn
  in CI; the *real* `codex exec` command is already exercised by the existing
  CodexCliIntelligenceProvider tests, so Step B's integration test verifies the
  *wiring*, not codex itself.)
- **Convergence flow with codex absent**: detection returns `unavailable`; assert the round
  completes internal-only, the lessons-aware reviewer still ran, the report carries the
  `## ⚠ Cross-model review: UNAVAILABLE` banner, the spec frontmatter carries
  `cross-model-review: unavailable`, and convergence is **still taggable** (never blocked).
- **Degraded path**: provider rejects (timeout/error/breaker-open); assert the round
  proceeds, the flag reads `degraded: <reason>`, and it does **not** collapse to
  `unavailable`.

### E2E (`tests/e2e/`) — scope note

There is no new HTTP route in Step B (the change is skill + a `src/` module the skill
calls), so the "feature is alive / returns 200 not 503" Phase-1 E2E pattern does not
directly apply — there is no endpoint to probe. The end-to-end assurance is provided by
the integration tests above (full convergence flow, codex-present vs codex-absent) plus
the existing `CodexCliIntelligenceProvider` provider tests that exercise the real
`codex exec` command. **If** Step C later exposes a status route (e.g.
`GET /spec/cross-model-reviewer` reporting detection state), that route gets the standard
Phase-1 E2E test then. Calling this out explicitly rather than silently skipping the tier.

## Migration parity

`/spec-converge`, `write-convergence-tag.mjs`, and `instar-dev-precommit.js` are the
**instar-developing agent's** tooling — they ship in the instar repo and are NOT installed
into arbitrary agent homes by `init` (same posture as Step A's gate). So **no
`PostUpdateMigrator` change is required for end agents.** The new `src/core/crossModelReviewer.ts`
is a library module consumed by the dev tooling, not a fleet-installed file.

Two parity points to keep honest:

1. **The skill content itself.** If `/spec-converge` is ever in the built-in-skills set
   installed into agent homes, an edit to its SKILL.md content needs the documented
   "updating existing skill content" migration path (an idempotent `PostUpdateMigrator`
   step, per the Migration Parity Standard). Step B must **check** whether spec-converge is
   in the installed-skills allowlist; if it is, add the idempotent content migration; if it
   is dev-only tooling, no migration. (Grounding finding: spec-converge is marked
   `user_invocable: false`, audience "instar-developing agent only" — strongly suggesting
   dev-only, but the build must confirm against the skills registry before concluding "no
   migration," not assume.)
2. **Agent Awareness.** Cross-model review is dev-process internal, not an end-user-facing
   capability, so the CLAUDE.md *template* (`generateClaudeMd()`) does not need a new
   Capabilities entry. The **instar-dev skill docs** (Step C) are where the developing
   agent learns that the external reviewer now runs through codex and what the
   `cross-model-review: unavailable` flag means — that awareness update is Step C's job,
   noted in Out of Scope.

## Safety / blast radius

- **Additive and fail-safe.** When no supported reviewer is installed, the system behaves
  like today's convergence (internal reviewers) **plus** a disclosure flag — strictly more
  information, never less function. When codex IS present, the external pass becomes real
  instead of hand-waved — strictly more review, not less.
- **No new credential, no new network dependency.** D3: the call rides the agent's existing
  `codex login` OAuth; the env allowlist (`buildCodexChildEnv`) keeps `OPENAI_API_KEY` out;
  the read-only sandbox + empty scratch dir mean a reviewer call cannot write to the repo or
  boot the agent's identity/hooks. The blast radius of a codex review is a bounded,
  sandboxed, read-only one-shot.
- **Never blocks.** Every failure mode (no framework, timeout, error, rate-limit, empty,
  unparseable) routes toward internal-only or a captured-raw finding — convergence always
  completes. The cross-model flag is **disclosure, not a gate**; it does not change the
  `review-convergence` + `approved` enforcement in `instar-dev-precommit.js`.
- **Prompt-injection surface.** The spec text under review is fed to codex as a prompt;
  a malicious spec could try to steer the reviewer. Mitigation: the reviewer runs read-only
  in an empty scratch dir with no tools and no repo access — the worst a poisoned spec can
  do is produce a misleading *review*, which a human reads in the report (the report banner
  + the internal lessons-aware reviewer are the cross-checks). It cannot exfiltrate or
  mutate anything (no write sandbox, allowlist env). This is the same trust posture as
  every other codex judgment call in instar.
- **Cost (worst case stated explicitly).** One `capable`-tier (`gpt-5.5`, a heavy reasoning
  model) call per convergence round. Convergence loops up to the **10-iteration hard cap**
  (SKILL.md Phase 3), so the worst case for a single spec's convergence is **~10 rounds × 1
  `gpt-5.5` call = ~10 capable-tier calls** before the cap forces a stop. Each call is
  bounded by the 120s timeout and the account-global circuit breaker; the context budget
  (60 KB) bounds prompt size. Convergence is a deliberate, infrequent, pre-build action (not
  a hot path), so even the 10-call ceiling per spec is acceptable; the breaker is the
  backstop if a burst of spec reviews hits the account limit (and once the breaker opens,
  the remaining rounds degrade rather than spend — see the `degraded-all-rounds` aggregate
  in §2/§4).

## Out of scope (later steps)

- **A second supported framework** (gemini-cli, etc.) — the registry is built as the
  extension point here, but only codex is wired. Adding gemini is a later step that pushes
  one registry entry.
- **instar-dev skill / CLAUDE.md-template awareness** of the new mechanism and the
  `cross-model-review` flag — **Step C**.
- **Migration of any deployed dev-tooling gate** — **Step D**.
- **Policy on the `unavailable` flag** — whether an `unavailable` spec should require an
  extra approval acknowledgment, raise the tier, or be surfaced on a review cadence. Step B
  records the flag honestly; whether the flag should *gate* anything is a deliberate policy
  question left for a later step (consistent with D4 "never block" — Step B's job is the
  truthful signal, not a new gate).
- **Replacing the internal Claude reviewers or the Standards-Conformance Gate** — untouched
  by design; Step B only re-platforms the *external* reviewer.
- **The content-quality regex gate** (`ConvergenceChecker` / `convergence-check.sh`) — a
  separate subsystem, not modified.
