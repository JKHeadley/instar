# Standards family delta review — Building gains *Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS*

## Scope and operator authority

This review covers one change to `docs/STANDARDS-REGISTRY.md`: a new article, *Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS*, inserted in the **Building** family directly before *References Run From Both Ends — the Registry Names the Code, the Code Names the Standard*.

The authority is the operator's explicit mandate of 2026-10-14 (Justin), issued the same day macOS TCC withdrew `~/Documents` access from the shared tmux server and two agents died in the same second on EPERM: "We need to make a global Instar mandate that the Documents folder on Mac is AVOIDED AT ALL COSTS." The task brief asked for a constitutional standard in the registry's house style that names the structural guard enforcing it, so the conformance audit can verify the guard exists on disk. The article was written together with that guard (`src/core/TccProtectedPathGuard.ts` and its wiring) in the same change.

## The delta, measured rather than described

- The registry gains exactly one `###` article in Building. Building's article count moves from 42 to 43; no other family's population changes (The Root 1, The Fractal 1, The Substrate 27, Shipping 7, Interaction 14).
- The hierarchy block's only change is its trailing count sentence: "The other 51 articles declare no parent" becomes "52". The count of declared relations (41) and parents (25) is unchanged, because the new article states its placement in the same prose form its neighbour uses (`**CHILD of *Structure beats Willpower***`), which the generator does not parse as a tree edge.
- No existing article text, tracker id, enforcement claim, reference or family membership changed. `git diff origin/main -- docs/STANDARDS-REGISTRY.md` is 9 insertions and 1 deletion.
- The generated registry asset and hierarchy block were regenerated; `generate-standards-hierarchy.mjs --check` is clean.

## Enforcement classification

The article is **enforced**, not documented-only: its *Applied through* names the guard module, the three init paths, the server boot block, the guard manifest row (`monitoring.tccProtectedPathGuard`, always-on, load-bearing), the `instar doctor` check, the migrator parity method, the runbook, and five test files across the three tiers. The coverage script reports zero dangling references and zero false claims for the article. Its one blocking decision (refusal at creation) is a deterministic containment test over a closed, platform-specific input, in the signal-vs-authority carve-out; everything at runtime is signal-only.

## Checks run on the candidate

`generate-standards-hierarchy.mjs --check`, `lint-registry-insertion-placement.mjs` (93 articles, 82 declaring a placement), `lint-registry-tree-parentage.mjs` (41 relations, all bidirectional), `lint-standard-code-backreference.mjs` (the three cited command files gained `Governed by:` headers), `lint-no-duplicate-definitions.mjs` and the full `npm run lint` chain are clean. The field-classification test confirms the article carries only recognized headings: Rule, Tree placement, In practice, Earned from, Traces to the goal, Applied through.

## Areas attested

| Family | areaSha256 | Verdict |
|---|---|---|
| Building | `440454f964ea3bd27088673bd9d59b6b2ea39c4139c78b5ddbcacd5c7ecf7c5d` | accepted |

## Independent acceptance

An independent verifier re-derived the claims from the repository rather than from this report: the single-article delta and the per-family counts from the `##`/`###` structure of both revisions; the hierarchy-block sentence and the unchanged relation count from the generator's `--check`; the recognized field headings; the existence on disk of every file named in *Applied through*; the coverage script's dangling and false-claim counts; the lint chain; and the correspondence between the Rule and the code (refusal gated on `darwin` before any write at all three init paths; boot detection with reopen-capable upsert, self-resolve on an empty finding set and a bounded sink; nothing moved; the "Honest scope" paragraph accurate). It read the current Building digest from `scripts/standards-coverage.mjs --json`.

It raised two notes, neither blocking, both resolved before acceptance:

1. **Parentage is prose, not a parsed edge.** The article's `CHILD of *Structure beats Willpower*` matches its neighbour's form and is not rendered in the hierarchy block. Accepted as matching precedent: the block's own preamble says a lineage note without a tree edge is not a misplaced child. Converting both articles to the parsed `a tree node under` syntax would also require the parent article to acknowledge them, which is an edit to *Structure beats Willpower* with its own ratification; that is deliberately not part of this delta.
2. **The Rule's list is broader than the check.** The Rule names worktrees, vaults, databases and logs; the guard classifies the project and state directories plus any paths a caller passes. The article's *Applied through* "Honest scope" paragraph states that gap explicitly, so the article is internally honest.

Reviewers: `echo:claude-code`, `independent-verifier:claude-code`.
