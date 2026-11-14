# Convergence Report — SafeGitExecutor: one verb classification for every surface

**Spec:** [docs/specs/safe-git-one-verb-classifier.md](../safe-git-one-verb-classifier.md)
**Slug:** `safe-git-one-verb-classifier`
**Converged at:** 2026-11-05
**Iterations:** 3
**Final-round design findings:** 1, a false sentence, corrected at the round cap (see Convergence verdict)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran through the codex CLI in all three rounds. Gemini was not available (not signed in). The clean-door Anthropic read degraded in round 1 (`override-not-frontier`). It is not a cross-model opinion and was not re-run.

## ELI10 Overview

Instar code may only run git through one safety funnel. The funnel has a door for commands that change things and a door for commands that only read, and each door kept its own list. A command on neither list was turned away at both, and each door told the caller to use the other. `git check-ignore` was one of those commands.

This change gives the funnel one table and one classifier. A command not in the table gets one clear refusal at every door. `check-ignore` joins the table as a read, including on Instar's own source tree when a caller opts in, so it can be used where it was first wanted.

The main tradeoff is scope. Review showed that some commands the funnel calls "read" can really write or run a program. That is true today and this change does not make it worse. Fixing it changes what runs, so it stays under EVO-029 with a wider record, not inside this change.

## Original vs Converged

- **Originally:** the two doors would give different errors on Instar's source tree for an unclassified command. **Now:** every door refuses it first, with the same message. **Why:** a guarantee with an exception is what this change was meant to remove, and the call was refused either way.
- **Originally:** `check-ignore` would have been reachable everywhere except the source tree, which is where it was first needed. **Now:** it joins the opt-in source-tree read list. **Why:** otherwise the goal was only half met.
- **Originally:** the spec said `check-ignore` could not run a program. **Now:** it says a repository's own settings can make it run one, as `git status` can. **Why:** three reviewers measured it.
- **Originally:** "read" read as a promise. **Now:** the spec says it means "the funnel classifies this as a read", and lists measured cases that write. **Why:** `remote -v add` and `config key --list` really do write through the read door. Echo reproduced both.
- **Originally:** the spec said a caller needed the verb. **Now:** it says a test reached for it and that nothing in `src/` calls it. **Why:** the first version was not true.
- **Originally:** nothing could catch a verb dropped from the lists. **Now:** a frozen copy of today's lists is pinned in a test. **Why:** tests that read the table they check cannot fail on the table.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | decision-completeness, security, adversarial, integration, lessons-aware, codex (scalability clean) | 12 | 11 | Refreshed against main, corrected the check-ignore rationale, added the source-tree read tier, added the EVO-029 disposition |
| 2 | security, adversarial, integration, decision-completeness, lessons-aware (codex: precision only) | 4 | 9 | Hoisted the unclassified refusal, corrected the "every agent home" claim, named the read-tier cap, added the frozen membership test |
| 3 | six lenses in one reviewer (codex: precision only) | 1 | 3 | One false sentence about the per-user ignore file corrected |

Standards-Conformance Gate, round 1: ran (2 flags).
Standards-Conformance Gate, round 2: ran (2 flags).
Standards-Conformance Gate, round 3: ran (2 flags).

The two flags are the same in every round: Signal vs. Authority and Verify the State. Both are about the funnel itself, not this change. The first rests on the registry article and `docs/signal-vs-authority.md` disagreeing about guards of this kind, reported as feedback fb-69615365-30f. The second is the measured read-surface writes, kept visible in the spec and in EVO-029. Round 2's lessons-aware reviewer weighed both and found the handling sound.

Reviewer models: internal reviewers ran as subagents of the authoring session on claude-opus-5-5. Round 1 used six reviewers. Round 2 grouped the six lenses into three reviewers. Round 3 used one reviewer for all six. Grouping was chosen because those rounds checked a delta on a small change. External: gpt-6-astra via codex in all rounds, on body hashes `554e7c5b`, `d2bc0243` and `278d596f`. Externals did not re-read the final one-sentence correction made after round 3.

## Proportion

Tier 1 by review size: about 170 added source lines, most of them the list becoming a table, plus one test file, and a revert undoes it all. 3 rounds used of a cap of 3. ⚠ Three rounds is at the top of the range for this size. The reason is that the draft was three weeks stale and the review kept finding real errors in what it said about the system.

## Left behind

- `--version` sits in the read list but cannot be reached, because verb extraction throws on it. Kept so the set stays the same.
- Test 5 reads the table it checks; test 12 is what pins membership.
- Test 2 walks only the table. The build also runs it over `git --list-cmds=main`, which closes most of this (codex, round 3).
- A `Map` cannot show a duplicate; the build checks the raw entries before the map is built (codex, round 3).
- `readSync(['remote','-v','add',...], {sourceTreeReadOk:true})` writes past the source-tree guard. Added to EVO-029 item 4.
- An exit 1 from `check-ignore` is audited as `denied`, as other exit-code probes are. Nothing reads that row.
- `check-ignore` is not used by the direct-git tests that carry `safe-git-allow`. They stay as they are, since they work on throwaway fixtures.
- Decisions state reversibility once, in Decision 7, not per decision.
- Item 1 still classifies the flag and not the verb through `run`. Stated in the spec, tracked in EVO-029.
- Registry and doc disagreement on guards of this kind: feedback fb-69615365-30f.
- The local `feedback-execute/base` branch advances on any `git fetch` here, because of a configured refspec. Noticed during review, and working as configured.

## Full Findings Catalog

**Round 1, design**

| # | Reviewer | Finding | Resolution |
|---|---|---|---|
| 1 | decision-completeness, adversarial | "One shared message" false on the source tree, because guard order differs by surface | Round 1 scoped it; round 2 hoisted the refusal |
| 2 | decision-completeness, adversarial | A three-value classifier cannot pick today's shape and verb wording | Surfaces read the table to pick wording |
| 3 | adversarial | The table misquoted `readStream`, which says "use `spawn`" | Corrected |
| 4 | security, lessons-aware, integration | `check-ignore` can run a program via `core.fsmonitor` | Rationale corrected, recorded as inherited |
| 5 | security | Program execution on read surfaces was unrecorded | EVO-029 item 5 widened |
| 6 | lessons-aware | "Known cases are named above" false: more read-surface writes exist | Named in the spec, EVO-029 item 4 widened |
| 7 | lessons-aware | "The verb a caller needed" was wrong | Reworded |
| 8 | lessons-aware | "None has a caller" contradicted item 3 | Reworded |
| 9 | codex, lessons-aware | `reflog` routing change was wider than stated | Documented, test added |
| 10 | lessons-aware | Item 3's stated reason was not supported | Reason replaced |
| 11 | adversarial | Test 9 as written could not run (`x=y` is not a valid key) | Uses `x.y=z` |
| 12 | integration | `check-ignore` stayed refused on the source tree | Joins the read tier |

**Round 2, design**

| # | Reviewer | Finding | Resolution |
|---|---|---|---|
| 13 | security, adversarial, lessons-aware | The read-tier cap test would go red, and the spec did not say so | Named, cap raised to 14 |
| 14 | security, adversarial, lessons-aware | "On every agent home" false: only source checkouts | Corrected |
| 15 | adversarial | The guard-order reason was wrong: it changes the error, not the refusal | Unclassified refusal hoisted |
| 16 | adversarial | Nothing tested that membership was unchanged | Test 12, a frozen literal copy |

**Round 3, design**

| # | Reviewer | Finding | Resolution |
|---|---|---|---|
| 17 | six-lens | "The funnel drops the global ignore file" false: `~/.config/git/ignore` still applies | Corrected, per-machine dependence stated |

Precision findings are listed under Left behind or were one-line fixes in passing.

## EVO-029 decision

Item 2 joins, as a consequence of the one table. Items 1, 3, 4, 5 and 6 follow. All six were re-read on `main`, and all are still present. Every reviewer who judged this agreed, including on keeping the measured read-surface writes separate. Fixing them changes what is refused today and needs per-verb evidence.

## Convergence verdict

Converged at the round-3 cap. Round 3's single design finding was a false sentence, not a design change. It was corrected and left nothing open that changes what gets built. It is not a safety, security or data-loss issue, so no operator step applies. The round-3 reviewer judged the hoist clean, and codex's round-3 findings were precision only. Spec is ready to build.
