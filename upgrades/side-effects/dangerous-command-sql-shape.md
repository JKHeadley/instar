# Side-Effects Review — Dangerous-command SQL statement shaping

**Version / slug:** `dangerous-command-sql-shape`
**Date:** `2026-07-11`
**Author:** `instar-codey`
**Second-pass reviewer:** not required

## Summary of the change

Four destructive SQL classifiers move out of the whole-input substring list into statement-shaped regular expressions. Each requires a statement boundary plus the expected keyword sequence and a following identifier. The non-SQL pattern list, safety-level branches, exit codes, identity context, and block response remain unchanged.

## Decision-point inventory

- Catastrophic command loop — pass-through, unchanged.
- Deployment/coherence loop — pass-through, unchanged.
- Filesystem/git risky loop — pass-through, same patterns and behavior.
- Destructive SQL classifier — modified from substring signal to statement-shape signal.
- Safety level 1/2 disposition — pass-through, same block/self-verification behavior.

## 1. Over-block

The intended reduction is prose false positives. A statement keyword at the beginning of input, after a SQL-bearing quote/separator, and followed by an identifier remains blocked. A prose line that merely mentions the vocabulary mid-sentence passes.

## 2. Under-block

The matcher remains conservative: raw statements, quoted database-client statements, optional existence clauses, optional table syntax, and ambiguous keyword-plus-identifier forms block. The tradeoff is deliberate asymmetry toward blocking executable-looking input.

## 3. Level-of-abstraction fit

The shell hook is the classification boundary that has the full tool input and already owns risky-command policy. No parser subsystem or new authority is introduced.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Existing authority, more precise signal.

The safety hook retains authority to stop risky commands. Only the evidence predicate becomes command-shaped; ambiguous cases still fail closed.

## 5. Interactions

- **Shadowing:** SQL classification remains within the existing risky-command phase.
- **Double-fire:** The SQL phrases were removed from the generic loop, so each input has one SQL decision path.
- **Races:** Stateless per invocation; no shared state added.
- **Feedback loops:** None; the hook performs one classification per tool call.

## 6. External surfaces

Users see fewer false confirmation prompts while writing or searching prose. Real blocks preserve the existing response and exit status. No config, API, storage, or network surface changes.

## 6b. Operator-surface quality

The safety response is unchanged. Passing prose produces no new output.

## 7. Multi-machine posture

Machine-local by design. Fresh installs and the always-overwrite migrator emit the same shaped policy on every agent; no distributed state is involved.

## 8. Rollback cost

Pure code/template rollback with no data migration.

## Conclusion

Clear to ship. This removes demonstrated prose over-blocks while retaining conservative blocking for real and ambiguous destructive statement shapes.

## Evidence pointers

- `tests/integration/codex-dangerous-command-block.test.ts`
- `tests/unit/dangerous-command-guard-sql-parity.test.ts`
- `tests/unit/dangerous-command-guard-force-with-lease.test.ts`
- `tests/unit/dangerous-command-guard-gh-pr-merge-gate.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller addition — not applicable.
