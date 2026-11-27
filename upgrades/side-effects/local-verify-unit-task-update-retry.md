# Side-effects review for the unit task-update timeout retry

## Summary

Tier 1. This is a reversible recovery change inside the existing verifier. It reads the installed reporter output and retries one eligible unit process. It adds no merge authority or configuration. The first commit attempt identified the missing review trace. The focused orchestrator, parser and reporter checks passed 212 tests, and the native TypeScript check passed.

## Over-block and under-block

An unknown reporter version, incomplete inventory, bounded error list with omitted messages, or split unit run stays on its existing path. These cases may still report infrastructure failure. The known timeout is matched exactly. Clean results from a retry require complete reports and matching per-file counts. A retry with a failed test cannot give a passing verdict through file isolation.

## Level of abstraction and signal versus authority

The reporter parser supplies a signal about a known tool error. The existing orchestrator owns process budgets and recovery. The existing verdict evaluator and coordinator own the final result and admission. The retry itself changes no operator or merge controls. The retry condition is an enumerable report format and error class.

## Interactions

The retry uses a different report name and the same lane deadline and suite slot. It runs at most once. The separate report paths prevent the two attempts from overwriting each other. An abort from a sibling lane still cancels the retry. When a retry ends with failed assertions, the original unhandled error remains in the evidence so a solo rerun cannot substitute for a passing full retry.

## External surfaces

The machine may spend the remainder of an existing unit deadline on a retry. The runner emits both attempt outcomes, and a kept failure retains process receipts. There is no operator action, external request, migration, or change to which receipts the coordinator trusts.

## Rollback

Revert the commit and update the verifier through the existing release process. There is no persisted state to migrate or repair.

## Independent review

The independent reviewer found that the initial version could let an assertion failure on the full retry reach file isolation. The implementation now preserves the original unhandled error and retains the assertion failure. The reviewer verified the correction and concurred.
