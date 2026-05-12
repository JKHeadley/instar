# Side-Effects Review — project-scope Phase 1b PR 1 (Drift checker + supervisor git-creds fix)

**Version / slug:** `project-scope-phase1b-pr1`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new LLM-mediated surface + new tmux-spawn flag)`

## Summary of the change

First PR of Phase 1b for the project-scope feature. Ships the *signal*
producer that Phase 1.5's round-runner will consume — the drift
checker that asks an `IntelligenceProvider` whether a spec's stated
premises still hold against the files it depends on. By itself it is
inert: nothing wires it up yet. The Phase 1b PR 2 (round runner) is
the first consumer.

Tag-along: a one-line fix to the server supervisor that has been
producing a runaway "Server unhealthy" restart loop on every fresh
spawn since at least v0.28.87. Discovered during the Phase 1a gate
verification this evening. Fix lives in the same PR because it
unblocks the supervisor (and therefore unblocks every agent that runs
into the credential-prompt loop) and is one line of code.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.4 (drift
checker). Supervisor fix is not spec'd — it's a defect repair.

New files:
- `src/core/ProjectDriftChecker.ts` (≈480 lines) — the verdict
  producer. Path-jails every file via the existing `jailPath` helper,
  reads spec + referenced files, enforces hard limits (count / per-file
  bytes / per-file lines / total token budget), wraps content in
  `<UNTRUSTED_SPEC_BODY>` / `<UNTRUSTED_FILE_CONTENT>` blocks, calls
  the provider with a 30s timeout + 1 retry, parses + structurally
  validates the response, re-verifies every citation against the bytes
  on disk, downgrades to `manual-review-required` whenever anything
  can't be trusted.
- `tests/unit/ProjectDriftChecker.test.ts` (45 tests) — covers path
  jail (`../`, absolute, symlink escape), prompt-injection delimiters,
  over-budget (count / bytes / lines / tokens), empty-spec,
  deleted-files, partial-deleted-files, schema-fail (no JSON / bad
  enum / non-string rationale / non-array citations), citation
  verification (byteRange OOB, fabricated file, LLM-claimed excerpt
  discarded), all-citations-fail downgrade, zero-citations no-downgrade,
  timeout (both calls fail) + timeout-then-success retry, non-timeout
  error bails immediately, code-fenced JSON tolerance, cacheKeyInputs
  determinism across file-order and instability across file-content /
  template-version / model-id changes.

Modified files:
- `src/core/types.ts` (+50/-2) — adds `DriftVerdict` and
  `VerifiedCitation` types, adds `timeoutMs` to `IntelligenceOptions`.
- `src/core/InitiativeTracker.ts` (+5/-2) — types
  `InitiativeRound.lastDriftVerdict` as `DriftVerdict` (was `unknown`,
  flagged "typed in Phase 1b" in the source comment), adds two
  companion fields `lastDriftVerdictAt` and
  `lastDriftReferencedFileHashes` that the round-runner will populate
  in PR 2.
- `src/lifeline/ServerSupervisor.ts` (+9/-1) — adds
  `'-e', 'GIT_TERMINAL_PROMPT=0'` to the `tmux new-session` invocation
  in `spawnServer()`. Comment block explains why (askpass fallback +
  inherited tmux server env). Source-pattern test in
  `tests/unit/server-supervisor-preflight.test.ts` (+25) asserts the
  flag is present in the new-session args.

Nothing else moves.

## Decision-point inventory

The drift checker IS a decision point — that's its purpose — but its
output is a **signal**, not authority. Round-runner (Phase 1b PR 2)
combines this signal with deterministic artifact checks before
deciding to start a round. The signal-vs-authority separation is
enforced both by the type system (the verdict is consumed only by
`ProjectRoundRunner` in PR 2) and by the spec.

- **Drift verdict** (`ProjectDriftChecker.run`) — **add** — produces
  one of `no-drift | minor-drift | premise-violated |
  manual-review-required`. The verdict alone is not enough to block
  or start a round; the round-runner combines it with frontmatter
  re-validation, PR/CI artifact checks, ownership, and ack state.
- **Path-jail rejection** (delegated to `jailPath`) — **reuse** —
  inherits the same allow-list behavior the StageTransitionValidator
  uses. Failure produces `manual-review-required`, never a soft pass.
- **Token-budget rejection** — **add** — over-budget input is rejected
  with `manual-review-required(over-budget)` rather than silently
  truncated. The spec explicitly forbids silent summarization to
  prevent a half-evaluated drift verdict being trusted.
- **Citation re-verification** — **add** — every LLM-proposed citation
  is independently re-read off disk. The LLM's claimed excerpt is
  discarded. If the LLM produced citations and none survived
  verification, the verdict is downgraded to
  `manual-review-required(failed-citation-verification)` — defense
  against fabricated evidence supporting a fabricated verdict.
- **Schema-fail downgrade** — **add** — any malformed LLM output
  (non-JSON, bad enum, missing fields) produces
  `manual-review-required(schema-fail)` rather than a best-guess.

Supervisor change has no decision-point semantics — it's an env-flag
addition that prevents git from prompting interactively. Drift is in
the BEHAVIOR of git-on-tmux, not in any agent decision.

## Over-block vs under-block analysis

### Drift checker

The verdict producer is at the right level of abstraction. It does
**not** read project records, it does **not** decide whether a round
may start, it does **not** persist anything. It takes an input
struct, returns a verdict struct. The round-runner (PR 2) holds all
authority. This matches the signal-vs-authority memory rule and the
spec.

Could it be over-blocking? The four "downgrade to
manual-review-required" paths (path-jail-fail, over-budget,
schema-fail, failed-citation-verification, timeout, no-provider) are
**deliberately conservative**. The spec is explicit: any failure mode
that means the verdict cannot be trusted MUST surface as user
attention rather than be treated as a soft pass. The cost of a
false-positive manual review is the user's eyeballs; the cost of a
soft pass is shipping something that doesn't match the code on disk.

Could it be under-blocking? The checker accepts a list of referenced
files from the caller — it doesn't *find* them itself by parsing the
spec. That's deliberate: parsing files-the-spec-claims-to-depend-on
is a job for the round-runner (or for spec frontmatter), not the
drift checker. Otherwise we'd have two places where spec parsing
lives, and they'd drift (irony noted).

The 50,000-token budget is a static cap rather than dynamically sized
to the provider. Caller bears the risk if they're using a provider
with a smaller context window — but in practice every supported
model has a window far bigger than 50k. Documented as a constant
that tests can override.

### Supervisor fix

The flag only affects git operations performed inside the spawned
tmux session. It does NOT change:
- Whether git is invoked (the auto-pull / git-sync code is unchanged).
- Whether credentials are tried (osxkeychain credential helper still
  runs first as configured).
- Whether non-interactive auth works (it does, as the same git pull
  works from any shell that inherits the supervisor env).

It only blocks the *interactive fallback* — git's behavior when both
the credential helper AND `GIT_ASKPASS` have failed. Before this PR
that fallback hung indefinitely behind a TTY prompt. After this PR
git returns a normal "could not read Username" error and the bash
command exits, the supervisor logs a degradation, and the next
restart attempt proceeds normally.

Under-block risk: zero. The flag does not silence auth errors, only
the prompt. Misconfigured credentials still surface as a visible
failure; they just no longer wedge the supervisor.

Over-block risk: a user who *wants* git to prompt them interactively
when running `git pull` inside `tmux attach -t echo-server` will no
longer see the prompt — but that's already an unusual workflow on a
supervisor-managed tmux session (the user is supposed to use their
own shell for that). Acceptable trade-off; the alternative is the
loop.

## Signal vs authority audit

Drift checker is a **signal source**. Three structural guarantees:

1. The verdict is the **only** thing the checker returns. It does not
   call into the InitiativeTracker, does not write to disk, does not
   short-circuit any other path. Authority for "may this round start"
   lives entirely in the round-runner (PR 2).
2. The `manual-review-required` verdict is **distinct** from the
   three "trustable" verdicts. Consumers cannot accidentally treat it
   as a soft pass: the type system requires them to discriminate.
3. Citation excerpts shown to the user / surfaced in the digest are
   re-rendered from disk by the checker, **not** the LLM's claimed
   text. A model that fabricates evidence cannot poison the digest
   that the user reads.

Supervisor fix has no signal-vs-authority semantics — it's an env
flag.

## Interactions with existing systems

- **IntelligenceProvider.** The checker is the third consumer of the
  abstraction (after `DiscoveryEvaluator` and `MessageSentinel`).
  Same call shape (`evaluate(prompt, options)`), same `'fast' |
  'balanced' | 'capable'` model tiers. Adds a per-call `timeoutMs`
  to `IntelligenceOptions`; existing providers ignore the field
  (signature is additive), and the checker enforces the timeout
  externally via `Promise.race` regardless. No provider needs to be
  updated.
- **InitiativeTracker.** The two new fields (`lastDriftVerdictAt`,
  `lastDriftReferencedFileHashes`) are optional and unused until the
  round-runner ships in PR 2. Records persisted today round-trip
  through TaskFlow's `stateJson` blob; the new fields will appear on
  read for any record they're written to and be silently absent for
  records that predate them.
- **Server supervisor.** The tmux flag survives an existing tmux
  server (per `man tmux`, `-e` is the per-session env that
  process.env cannot reach once tmux is already running). The flag
  is set on every new server-session spawn, including the recovery
  path after a wake or a restart.
- **Existing routes / skills.** No route changes in this PR. The
  `/projects/:id/drift-check` endpoint mentioned in the spec lands
  with the round-runner in PR 2.

## Rollback cost

Drift checker is inert if reverted — no callers, no migration to
unwind, no on-disk state. Reverting `src/core/types.ts` removes the
`DriftVerdict` export, which is a compile-time impact for any
downstream code that imports it — but no such code exists yet.

Supervisor fix is a one-line revert. The git-prompt-hang behavior
returns; mitigation is to set `GIT_TERMINAL_PROMPT=0` in the user's
launchd plist environment (which is also why the source comment
explains *why* the flag is needed: future authors will not
accidentally remove it thinking it's redundant).

## What this PR explicitly defers

Per spec § Phase 1.4, these belong to drift but ship in Phase 1b
PR 2 alongside the round-runner:

- **Cache** keyed by `sha256(promptTemplateVersion + modelId +
  specBodySha + sortedFileHashes)`, TTL 24h. The function that builds
  the cache-key inputs is shipped here (`cacheKeyInputs`) so the
  consumer in PR 2 doesn't fork the implementation; what's missing
  is the store + lookup + TTL.
- **Mtime fast-path** — re-uses last cache entry if (specPath mtime,
  referenced-file mtimes) all match, skipping the sha256 work.
- **Cost ledger** at `.instar/drift-spend-YYYY-MM-DD.jsonl` with
  flock-protected pre-reservation and a $1/day per-agent ceiling.
- **`POST /projects/:id/drift-check` HTTP endpoint** (mutex-guarded
  per-project).

Each of these is additive — the checker as shipped returns a correct
verdict on every call, just without rate-limit or memoization.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/ProjectDriftChecker.test.ts
  tests/unit/server-supervisor-preflight.test.ts` — 50/50 pass.
- Manual review of the source against spec § Phase 1.4: the four
  hardening properties (path jail, prompt delimiters, schema validation,
  citation re-verification) are each backed by at least two test
  cases. The token budget enforces the spec's "never silently
  summarize" rule.
- Supervisor fix verified live: setting `GIT_TERMINAL_PROMPT=0` at
  the tmux global env unblocked the runaway-restart loop on the
  author's own server during this evening's gate verification.
