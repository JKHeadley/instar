# Side-Effects Review — Stage-A two-hats boundary + leakage detector (§19.3)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** New pure-logic module `src/monitoring/MentorStageA.ts` — the structural pieces the
§19.4 mentor job wires: `STAGE_A_ALLOWED_TOOLS` (empty tool grant), `buildStageAContext()`
(conversation-surface-only prompt builder), `detectStageALeak()` (the mandatory leakage detector
with positive-control + canary), and `leakToFinding()`. No routes, no I/O, no server change.
**Files:** `src/monitoring/MentorStageA.ts`, `tests/unit/MentorStageA.test.ts`, `upgrades/NEXT.md`.

## Principle check (Phase 1)

Does this involve a decision point that gates info flow / blocks actions / constrains behavior?
**Indirectly, and on the right side of it.** This module makes the two-hats separation *structural*
rather than a prompt instruction (Structure > Willpower). It does not itself block anything at
runtime — it provides (a) the tool-grant the job passes to `spawnSession` (the actual enforcement
is SessionManager/Claude-CLI `--allowedTools`), and (b) a detector that emits a *signal* (a leak
candidate for the ledger). The detector has no authority — it logs; the human decides. Signal-only.

## The seven questions

1. **Over-block.** The leakage detector could false-positive on a transcript that legitimately
   echoes an internal reference the *user* put in the conversation. Mitigated structurally: a hit is
   only counted if the reference is absent from the surface text (`!surfaceText.includes(ref)`), and
   a test proves "PR #412 in the surface → echoing it is NOT a leak." `STAGE_A_ALLOWED_TOOLS = []`
   "over-blocks" all tools by design — correct, since the surface is injected, not fetched.

2. **Under-block.** The detector is pattern-based (source paths, file:line, rollout/log refs,
   PR#/SHA). A leak phrased in pure prose with no reference token ("your retry logic is broken")
   wouldn't trip it — but that's also not a *provable* leak (it could be a lucky guess), and the
   empty tool grant already prevents Stage A from *fetching* internals, so the only leak vector is
   cross-tick *recall*, which the detector catches whenever it surfaces a concrete reference. The
   canary guarantees the detector itself can't silently rot.

3. **Level-of-abstraction fit.** Pure logic in `src/monitoring/`, consumed by the §19.4 job. The
   actual tool enforcement lives at the right (lower) layer — SessionManager's `allowedTools` →
   Claude CLI `--allowedTools` / Codex read-only sandbox. This module supplies the *policy*, not a
   parallel enforcement mechanism.

4. **Signal vs authority.** Compliant. `detectStageALeak` returns a result (signal);
   `leakToFinding` turns it into a ledger candidate. Neither blocks. The empty tool grant IS the
   authority, but it's enforced by the CLI, not by this module.

5. **Interactions.** No runtime wiring yet (the job in §19.4 calls these). `leakToFinding` produces
   a `ForensicFinding` consumed by the ledger's `captureRun` — the dedupKey `<fw>::stage-a-leak`
   collapses repeat leaks into one canonical issue, so a recurring leak doesn't flood. No shadowing.

6. **External surfaces.** None new — no routes, no template change, no config. Internal module only.

7. **Rollback cost.** Trivial. Pure logic with no caller until §19.4; revert = delete two files.

## Phase 5 — second-pass

The change *touches the two-hats boundary*, which is decision-bearing in spirit, so per the
high-risk trigger ("guard"/"gate") I considered a second pass. Conclusion: this PR is the *policy
definition* (pure, fully unit-tested incl. positive-control), not the runtime enforcement — the
enforcement (spawn with empty grant) and the live detector wiring land in §19.4, where the
second-pass reviewer is warranted. Noting it here so §19.4 carries the dedicated second pass.

## Testing

Pure logic → Tier-1 is the applicable tier (no HTTP surface to integration/e2e-test; the §19.4 job
gets the "alive" e2e when Stage A actually spawns). 12 unit tests: empty tool grant denies every
internals tool; context builder includes only the surface + the two-hats preamble; detector flags
code/rollout/log/PR/SHA references absent from the surface; does NOT flag clean prose or a
user-supplied reference; **positive-control canary trips the detector**; `leakToFinding` yields a
high-sev instar-integration-gap with opaque evidence. Affected suite green vs canonical main.
