# Side-Effects Review — SafeGitExecutor one verb classification

**Version / slug:** `safe-git-one-verb-classifier`
**Date:** `2026-11-04`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The git funnel kept two verb lists, one per kind of surface, so a verb in neither list was refused by both and each refusal named the other (EVO-028). `src/core/SafeGitExecutor.ts` now has one table, `GIT_VERB_CLASSES`, and one classifier, `classifyGitInvocation`, which all five entry points use. The two exported sets are derived from the table. `check-ignore` is added as a read and joins `SOURCE_TREE_READ_TIER_VERBS`. An unclassified verb gets one shared refusal on every surface. `reflog` becomes a `shape` verb, so its non-read forms route through `run` to `execSync`. Tests: `tests/unit/SafeGitExecutor-verb-classifier.test.ts` (new), plus one-line updates to `tests/unit/SafeGitExecutor.test.ts` and `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`.

Proportion: Tier 1 declared, because a revert fully undoes it and it adds no new authority, with the full chain run anyway because this is the safety funnel (converged spec, second-pass review). About 170 added source lines, most of them the list becoming a table. Three spec rounds, at the cap. The draft was three weeks stale and the rounds kept finding real errors in what it said about the system.

## Decision-point inventory

- `SafeGitExecutor` verb gate — modify — same gate, one source of truth. No new blocking authority.
- `SafeGitExecutor.run` routing — modify — routes on the classifier. Only `reflog` routing changes.
- `SOURCE_TREE_READ_TIER_VERBS` — modify — gains `check-ignore`, opt-in per call.

---

## 1. Over-block

No legitimate call is newly refused. Every verb the classifier calls `unclassified` was refused by both surfaces before. Harmless unclassified verbs (`check-attr`, `show-branch`) stay refused on purpose; EVO-028 approved one verb, and each further one needs its own check. The refusal now tells the caller that adding a verb is a reviewed change.

---

## 2. Under-block

This change does not close existing gaps. Read-classified invocations can still write or run a program: `remote -v add`, `config key --list`, `format-patch`, `hash-object -w`, `write-tree`, `symbolic-ref`, `--output` on `diff`, `log` and `show`, repo-local `core.fsmonitor`, `diff.external`. Echo reproduced the first two. Those are EVO-029 items 4 and 5 <!-- tracked: CMT-1124 -->, and the record was widened in this run. `check-ignore` inherits the `core.fsmonitor` exposure that `status` already has, so it adds no new class. `run` still reads `args[0]`, so a pre-verb flag is routed to `readSync` (EVO-029 item 1 <!-- tracked: CMT-1124 -->).

---

## 3. Level-of-abstraction fit

Right layer. The contradiction lived inside the funnel, and the classification belongs next to the shape checks it calls. Two scripts keep their own verb lists for unrelated jobs and are left alone (EVO-029 item 6 <!-- tracked: CMT-1124 -->).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

None of the four boxes fits exactly, so this is stated directly. The funnel is a deterministic allowlist over git's fixed command grammar. It judges no meaning and it predates this change. `docs/signal-vs-authority.md` names hard-invariant validators as outside the principle and a deterministic policy evaluator as a valid authority where inputs can be enumerated. This change adds no blocking authority: everything it refuses was refused already. The Standards-Conformance Gate flagged this in all three rounds, because the registry article names only the emergency-stop floor as an exception. That disagreement between the two documents is filed as feedback fb-69615365-30f and needs a ruling, because the registry is the constitution.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals point. Whether a verb is in a closed table has no competing signals.

---

## 5. Interactions

- **Source-tree guard:** the unclassified refusal now comes before the guard on `execSync` and `spawn`. That call was refused either way; only the error changes, from `SourceTreeGuardError` to `SafeGitExecutorError`. `leaseMediumSelection.ts:67` treats both alike. Classified verbs keep their order, pinned by a test.
- **`GitStateManager.ts:345`:** `update-index --refresh` is still refused and swallowed; only the swallowed text changes.
- **`machine.ts:174`:** unchanged. It still reaches `readSync` and is refused.
- **Audit log:** one new reason, `unclassified-verb`. Nothing reads audit reasons.

---

## 6. External surfaces

None. No route, config, message, file or agent-installed surface changes. Refusal text changes only for unclassified verbs, and nothing in `src/` or `scripts/` reads refusal text.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

No new state, notice or URL. This is in-process classification that ships identically to every machine. The one machine dependence is in git, not here: `check-ignore` reads `.git/info/exclude` and the per-user ignore file (`$XDG_CONFIG_HOME/git/ignore`, by default `~/.config/git/ignore`, unless a repo-local `core.excludesFile` overrides it), so its answer can differ per machine. The spec states this for callers. No status surface changes.

---

## 8. Rollback cost

Revert the commit. No stored state, config or migration. After a revert `check-ignore` is unreachable again and the contradictory messages return.

---

## Conclusion

Three review rounds changed the design in two ways: the unclassified refusal moved ahead of the source-tree guard, and `check-ignore` joined the source-tree read tier, without which the goal was only half met. They also corrected several false statements in the spec and exposed the wider gap now recorded under EVO-029. Clear to ship as a consistency fix. It is not a claim that the read surfaces are safe.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), read-only, no shared context beyond this artifact and the diff
**Independent read of the artifact: concur**

Concur after two wording corrections, both applied: the per-user ignore file description, and "added" not "changed" for the line count. The reviewer ran old and new code side by side with a fake git over every table verb and every `git --list-cmds=main` command on all five surfaces, on plain and source-tree fixtures. Only three groups differ: unclassified verbs, `check-ignore`, and `run` with `reflog`. Table membership matches the old lists plus the two stated additions. Unstated and harmless: `run([''])` now reaches `readSync` and is still refused.

---

## Evidence pointers

Disconfirmation on unchanged source: 14 of 16 tests failed for the expected reasons, including "readSync called with destructive verb 'check-ignore'" and "destructive shape 'reflog expire ...'". Convergence report: `docs/specs/reports/safe-git-one-verb-classifier-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes source code, and adds no self-triggered controller.
