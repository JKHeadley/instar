# The conversation graph re-checks only the records that changed

<!-- bump: patch -->

## What Changed

`ConversationGraphReplication.certifiedUnion` verified every stored row on every call (`verify`, then `fullyPersisted`, then the descriptor hash), and it runs once per revalidation during Accept all, once per read-view build and in the source inventory runner. At ~550 rows that is 1-3 s of synchronous CPU per call on a loaded host. It now remembers each stored row's results (per row object, WeakMap) and reuses them while the row's top-level values and a per-pass context are unchanged. The context covers everything the per-row work reads that can change: a verifier epoch bumped at the class-local erasure and member-loss state writes, the local deny fence's grow-only answer signature (root check, corrupt flag, deny-set size of the shared state), a signature of the witness key map and a hash of the installed membership. Rows whose checks read the clock, files or custody lineage (materialization, erasure, member-loss adoption, erased control, custody activations) are always verified fresh. Answers are unchanged.

Tests run with a check mode (`INSTAR_GRAPH_VERDICT_MEMO_CHECK=1`, set in `tests/vitest-setup.ts`): every reuse is recomputed and compared, stored rows' values are frozen so a nested edit fails, and any divergence fails the test. `INSTAR_GRAPH_VERDICT_MEMO=off` (read at start) turns the memo off.

## What to Tell Your User

- **Faster graph checks while saving**: "When you accept several projects at once, I now re-check only the records that changed instead of every record each time, so I stay responsive while saving."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Incremental verification of the conversation graph | Automatic (`INSTAR_GRAPH_VERDICT_MEMO=off` disables it) |

## Evidence

Spec `docs/specs/graph-verify-verdict-memo.md`, converged over 5 review rounds (internal reviewers + GPT-family external reviewer). Tests: `tests/unit/conversation-graph-verdict-memo.test.ts` (reuse and miss, warm pass makes no verify call with check mode off, context changes for each verifier input, shared fence signature, grow-only fence, memo-off paths, excluded rows, freeze and divergence, covered rows never reach excluded helpers, field-read classification over the transitive helper closure, epoch bump at every class-local write) and the existing graph unit suites run with check mode on.
