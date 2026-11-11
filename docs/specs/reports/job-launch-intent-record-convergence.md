# Convergence Report: Job launch intent and launch record (per-job thinking mode)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-family review ran in all 3 rounds, with the verdict MINOR ISSUES each time. A clean-door Anthropic read, `claude-code:claude-fable-5-2`, also ran in all 3 rounds (MINOR ISSUES each time). Fable is the same model family as the author, so it is disclosed separately and does not count as cross-model. The internal reviews covered all six lenses: six separate reviewers in round 1, two combined reviewers in round 2 and one in round 3. The Standards-Conformance Gate ran every round and raised 3, 2 and 1 flags. Its round-3 flag was a false positive, confirmed against the coverage test and `MaturationLadder.ts:313`.

## ELI10 overview

Instar's scheduled jobs all run at the AI engine's default "how hard to think" setting. A simple daily summary therefore costs the same thinking as a careful code review. This spec lets a job set a neutral thinking level. Each engine's own launch code translates it: Claude Code's effort flag, or Codex's reasoning setting. Engines without such a setting skip it and say so.

Every job run also records what the engine was actually told and which engine version ran. The same record will later serve every other engine feature (backup models, tighter permissions, the advisor), so each one can show an honest before-and-after.

A small check in the build also stops new "is this Claude or Codex?" code from spreading outside each engine's own section. That kind of code already appears in about 350 places, and the check stops the number from growing.

## Original vs converged

- **The CLI version.** The original read it once per server process. A self-updating engine would then have been recorded with a stale version, and the read could block a spawn. Now it is cached by file identity with a 1-hour limit, probed asynchronously against the binary that actually launches, and patched onto the run row afterwards. The spawn and the start record are never delayed.
- **"Off".** The original left it undefined. Now, on Claude Code it uses the environment setting that topic sessions already use. On Codex it maps to "low", and the record shows both the requested and the sent value.
- **What the record claims.** The original said "replicated". Run history is in fact machine-local, so the spec now states the inherited posture honestly and files the gap separately (fb-ca7635e0-b76).
- **Where the field is read.** The original listed only frontmatter. The field is now on every job path, including the agentmd manifest, which is the authority. A clamp inside the builder catches anything that bypasses the loader.
- **Graduation.** The original used a fixed "20% less" pass/fail judged by Justin. It is now a proper Maturation plan:
  - the recurring maturation review's model decides;
  - noise-aware floors apply;
  - only runs that actually received the setting count;
  - the two arms alternate by day so engine versions match;
  - Justin's charter confirmation sits on top.
- **The ratchet.** The original counted only `===` comparisons. It now counts every framework-id string literal outside the adapters, per file and in total. Moves between files are allowed.

## Iteration summary

| Round | Spec | Distinct DESIGN findings | New mechanisms | Words | Notes |
|---|---|---|---|---|---|
| 1 | f8b3f90d… | 10 | 0 | 1,335 | All resolved in round 2 |
| 2 | f8579b95… | 6 | 0 | 1,675 | Every round-1 resolution held. Tripwire fired on the count (10 to 6, not halved). Echo overrode it, with reasons disclosed in `round2-triage.md` |
| 3 | f6c73d7e… | 2 | 0 | 2,086 | Astra: graduation didn't establish treatment. Internal: the 2-second wait broke completion matching. Both were fixed after the round and checked by a targeted verification |
| final | c5fd5704… | — | 0 | 2,253 | At the 1.5× word warning (2,250) |

Standards-Conformance Gate: ran every round (3, 2 and 1 flags).

## Proportion

The spec is Tier 2, touching the scheduler spawn path, the launch builders, JobRunHistory and a CI lint. It used 3 rounds of a 3-round cap, plus one targeted verification. The spec grew from 1,335 to 2,253 words, landing at the 1.5× warning line, with no new mechanisms. That is in line with the change's size, unlike the step-0 confirm-tap spec, which reached 6,880 words and failed.

## Left behind (precision, one line each)

- Undefined local terms for outside readers ("Jev grade", "lane"). These are standard Instar vocabulary.
- An env value inherited from the server's own environment is not distinguished from one this launch sent (stated in the spec).
- The ratchet is a floor, not a proof: constants and concatenation get past it (stated).
- The graduation floor verdict is computed by a script and read by the review model. The script is part of the build.
- The ladder line passes, but the coverage test's dangling-name check only reads specs in `docs/specs/`. The spec will be there once merged.

## Convergence verdict

**Converged at the round cap (3), with two round-3 design findings fixed afterwards and confirmed by a targeted verification** (GPT 6 Astra and an internal reviewer each returned RESOLVED for both fixes; see `job-launch-intent-record-rounds/`). No safety, security or data-loss finding is open. The spec is ready for Justin's review and `approved: true`.

## Post-verification edits (disclosed)

After the targeted verification, the tag writer refused the stamp: four `invariant` rows lacked a declared `basis` and `evidence`. Echo added a basis and evidence to each row. Each one cites code or the constitution (Rule 30, `validateEffortLevel`, the interactive pin precedence), and the classification of every row is unchanged. These rows were not re-reviewed. The second edit adds one sentence to §4, as the verifier advised: `recordLaunchVersion` copies the latest row whole.
