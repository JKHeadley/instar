# Side-Effects Review — Honest pre-push affected-test selection

**Version / slug:** `r1-structured-vitest-list`
**Date:** `2026-08-18`
**Author:** `Instar-codey`
**Second-pass reviewer:** Codex independent reviewer (`r1_side_effects_review`)

## Summary of the change

This change replaces rendered-line counting in `scripts/lib/pre-push-scope.mjs` and
`scripts/pre-push-smoke.mjs` with a strict parser for the pinned Vitest JSON list schema. It
separates valid zero, valid affected, valid over-cap, parse/schema failure, process failure, and
timeout outcomes. Timeout remains a CI-backed non-blocking skip but becomes unambiguously visible
as `SKIPPED` with zero tests run. Focused coverage lives in
`tests/unit/scripts/pre-push-scope.test.ts`; `vitest.push.config.ts` gains an opt-in cache-directory
seam used to keep proof state outside a shared dependency tree.

This is declared Tier 1 despite the size signal's Tier-2 suggestion. The risk floor is Tier 1, the
production application runtime and CI are untouched, the change is confined to contributor-side
local smoke selection, and the additional lines are primarily strict boundary controls and tests.
The PR remains the review surface.

## Build grounding and plan record

- Fresh worktree: created by `instar worktree create` at
  `/Users/justin/.instar/agents/instar-codey/.worktrees/phaseb-r1-structured-vitest-list`.
- Base: protected `upstream/main` at `248ed7177f5bf416aa7bdad9763741478195e1fc`, locally and
  remotely verified.
- Remotes: `upstream=https://github.com/JKHeadley/instar.git` and
  `origin=https://github.com/JKHeadley/instar-codey.git`.
- Package version before build: `1.3.1180`.
- Problem: human-formatted list output could collapse or inflate into exit-zero-without-tests;
  timeout was another naturally observed exit-zero-without-tests path.
- Fix: consume and pin structured output; keep proved zero distinct from indeterminate; make
  timeout visibly skipped without turning local machine slowness into a push veto.
- Acceptance: malformed/empty/old/schema-changed inputs refuse; valid zero stays quiet; valid
  affected data runs; valid over-cap data skips; timeout says skipped and zero tests; pinned live
  Vitest JSON parses; focused tests and lint pass.
- Rollback: revert this pure code/config change; no persisted application state requires repair.

## Decision-point inventory

- `scripts/pre-push-smoke.mjs` list-process disposition — **modify** — maps process success to
  parsing, timeout to a visible non-blocking skip, and other process failures to failure.
- `scripts/pre-push-smoke.mjs` affected-set disposition — **modify** — valid zero exits cleanly,
  valid over-cap data deliberately skips, valid in-cap data runs, and unproved data fails.
- `scripts/lib/pre-push-scope.mjs` JSON boundary — **add** — validates the enumerable pinned
  machine schema before any count can influence a decision.

These are contributor-tooling decisions. CI remains the protected merge authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The strict schema intentionally rejects a future Vitest release that adds an otherwise harmless
field, changes the top-level shape, emits relative paths, or changes the entry names. Because the
repository pins Vitest, that is a version-update integration failure rather than an arbitrary live
input. It is preferable to a false local pass and is repaired by reviewing and updating the pinned
contract with the dependency upgrade.

Malformed, empty, or old rendered data now blocks the local push instead of silently claiming no
tests. This is appropriate when the subprocess completed normally: the machine is responsive, but
the evidence contract failed. Timeout is handled separately and remains non-blocking, preventing
disk contention from becoming an over-block.

---

## 2. Under-block

**What failure modes does this still miss?**

- A valid structured affected set can omit a genuinely affected test because Vitest's dependency
  graph is incomplete. That is an existing limitation of `--changed`; authoritative full-suite CI
  remains the backstop.
- A valid affected set over the existing breadth caps still skips locally. This is deliberate and
  now based on proved structured counts, but it still runs zero local tests.
- A listing timeout still exits zero and runs no local tests. The remaining under-block is explicit
  (`SKIPPED`, `tests_run=0`) and backed by CI rather than disguised as a local pass.
- A process killed by `SIGTERM` for a reason other than the configured `spawnSync` timeout would be
  described as timed out. In this synchronous private callsite, the configured timeout is the
  source of `SIGTERM`; there is no interactive cancellation path.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Vitest owns selection; the local wrapper owns validating the machine contract, deciding
whether local work is bounded, and explaining the local result. Counting structured entries in the
shared scope helper lets tests exercise the same primitive used by the script. CI remains at the
higher authority layer and was not duplicated or weakened.

Failing on an invalid successful response is boundary validation over an enumerable schema, not a
semantic judgment. Keeping timeout non-blocking belongs in the wrapper, which knows this is a
best-effort contributor tier and can name CI as the authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

None of the checkbox descriptions precisely describes this constrained mechanical boundary. The
script does block a local push when a subprocess returns success but violates the pinned JSON
schema. That is permitted **hard-invariant validation** under the cited principle: valid inputs are
fully enumerable and no conversational or semantic judgment is being made. The policy choice for
environmental unavailability is not hidden inside the validator: timeout produces an explicit
non-blocking signal, while protected CI remains the final authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic exists at a competing-signals decision point. JSON structure and absolute
path validity are enumerable boundary invariants. Existing numeric caps are preserved, not added.
The timeout policy has one environmental fact and one declared authority relationship: local smoke
is best-effort; CI is exhaustive and merge-blocking.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** Git policy checks still run before local smoke. Within smoke, a list-contract
  failure stops before breadth or run decisions because neither is meaningful without a set.
- **Double-fire:** local smoke and CI intentionally both test branches. A local skip leaves only CI;
  no second local actor consumes the marker.
- **Races:** the list JSON uses a unique temporary directory and is removed in `finally`. The test
  result report already uses the same isolated-directory pattern. No shared output filename races.
- **Feedback loops:** no result is fed back into future decisions. The optional Vitest cache is
  scheduling state only; proof uses a dedicated external directory.
- **Adjacent retry:** failed test execution retains its existing focused retry. Listing failure or
  timeout occurs before execution and is not misreported as a test failure eligible for retry.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Contributors and build agents see stricter failures for invalid list evidence and a clearer
  timeout skip message.
- Application users, Telegram/Slack users, external APIs, and CI behavior are unchanged.
- No durable application state is written. List and result artifacts use temporary directories.
- Timing remains machine-dependent; the timeout is intentionally non-blocking because a natural
  timeout occurred during this work window on the disk-contended machine.
- No operator-facing action is added. There is no dashboard, approval, or phone workflow surface.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** A pre-push hook measures the current checkout, current machine's
dependency graph, and current machine's ability to run tests. Those facts should differ per machine
and are not durable agent state to replicate or proxy. Each machine's branch still enters the same
protected CI authority after push.

This change emits no user-facing notices requiring one-voice gating, holds no durable state that
could strand on topic transfer, and generates no URLs.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the four implementation/test/config files and ship the next patch.
- **Data migration:** none; no schema or persisted application state.
- **Agent state repair:** none. Temporary proof/list files are removed or live outside the repo.
- **User visibility:** only contributors would temporarily regain ambiguous local smoke output;
  protected CI would remain unchanged throughout rollback.

---

## Conclusion

The design is clear to ship for independent review. The strict successful-response path could
over-block on a future Vitest schema addition, but that is the intended loud dependency-upgrade
failure. Timeout remains the honest non-blocking exception, and the new marker prevents it from
being mistaken for tests having run. CI retains final authority; no application runtime or
external-system behavior changes.

---

## Second-pass review (required)

**Reviewer:** Codex independent reviewer (`r1_side_effects_review`)
**Independent read of the artifact:** concur

Concur with the review — strict schema blocking is an enumerable pinned boundary, timeout remains
non-blocking and unmistakably reports `SKIPPED` with zero tests, and no missed interaction changes
CI's authority.

---

## Evidence pointers

- `tests/unit/scripts/pre-push-scope.test.ts`
- `scratchpad/phaseB/REPORT-R1.md` (uncommitted lane record in the coordinating checkout)
- Focused proof: 1 file / 20 tests passed; pinned Vitest live JSON parsed as 1 file / 20 cases.
- Full repository lint executed by the first commit attempt; ordinary checks passed and the
  process gate correctly stopped only for this then-missing side-effects trace.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is an ordinary product parser in a
contributor-side script. The config change is only an opt-in cache-location seam and is not the
source of the defect.
