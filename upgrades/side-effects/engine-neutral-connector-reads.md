# Side-Effects Review — Engine-Neutral Connector Reads

**Version / slug:** `engine-neutral-connector-reads`
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** independent inherited-model `review_connector_reads` (read-only).

## Summary of the change

Tier 1: a narrow reversible parser repair in effect-kinds and the generated external-operation hook, with unit, HTTP and lifecycle tests. It recognizes read verbs in both namespaced tool spellings for any MCP service. No grant, schema, account, schedule, or global autonomy change. Two production files; one review round with a focused correction; no commit attempts yet.

## Decision-point inventory

- `deriveEffect` / `verbRules`: modify the existing effect signal; preserve the full tool name and service for identity and policy.
- Generated external-operation hook: modify the matching read classification; continue using the existing server authority for governed calls.
- `migrateHooks`: pass-through existing always-overwrite built-in hook path, pinned by executed migration tests.
- Trust admission, sign-in and owner approval: unchanged authority.

## 1. Over-block

Unknown verbs, unrecognized flattened connector prefixes, and names combining a read with push/comment/merge remain governed. For example `github_inspect_read_only` is not inferred to be a read. A namespace that itself names a mutation can conservatively keep the call governed. No new engine-specific exclusion.

## 2. Under-block

Names are metadata, not a proof of implementation: a maliciously misnamed tool can still advertise a read name while performing a write, as with existing direct read names. This patch does not claim semantic tool inspection. Whole-token matching avoids substrings such as fetcher; mutation and execution tokens anywhere veto a read. Tests cover both namespace spellings, alternate services, mixed actions, unknown verbs and sign-in preservation.

## 3. Level-of-abstraction fit

The existing effect-name parser is the correct layer: the defect exists before trust admission, not in account permissions. The hook and server both receive the corrected classification; no parallel policy or engine allowlist is added.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

The parser supplies the existing deterministic effect vocabulary to the existing trust authority. It adds no competing blocker. The read policy is unchanged; this restores the proper inputs to that policy. The hook retains its existing conservative fail-closed behavior for governed operations after trust import.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. This is an enumerable tool-name grammar correction, not a decision from competing user intent, liveness or ownership signals.

## 5. Interactions

- Shadowing: corrected reads reach the existing not-gated/read decision without an owner card; mutations continue to the existing gate.
- Double-fire: no tool execution, retry or notification is added.
- Races: pure classification changes no shared state; generated hooks are still overwritten by the existing update path.
- Feedback loops: no self-triggered controller changes. Engine-neutral tests compare hook requests with real server derivation.

## 6. External surfaces

Connected repository reads work without unnecessary approval across engines. No GitHub calls are made by these tests. No operator-facing action or approval surface is added; publishing remains Chief-owned. Existing deployed agents receive the hook on update, while custom hooks and permission records remain unchanged.

## 7. Machine / pool scope

Applies identically wherever this package is installed, with no account or machine exception. The serving-lease and trust forwarding rules remain unchanged. No local live install was modified.

## 8. Rollback cost

Revert this patch and publish a patch release; the existing migration replaces the built-in hook again. No grant or data cleanup. Unnecessary read approvals return while rollback propagates.

## Conclusion

Focused unit, HTTP integration and started-server lifecycle checks pass. The update test runs the installed hook and confirms replacement, idempotency and custom-hook preservation. Independent review found that an arbitrary unknown first word could be mistaken for a flattened namespace. The correction recognizes only the observed GitHub alias in that spelling, while explicit namespaces retain the actual final tool segment. Six added server/hook negatives failed before this correction; full-suite verification is assigned to throughput before publishing.

## Second-pass review (if required)

The inherited-model read-only reviewer raised the unknown-prefix issue (`inspect_read`, `launch_get_status`, `unknown_get`). All three now have independent negative assertions in both classifier and executable-hook tests, plus HTTP/lifecycle coverage. Concur with the corrected review: the bounded GitHub alias closes the unknown-direct-verb issue, server and hook rules match, and migration coverage remains sound. The reviewer found no further source concerns and ran no tests.

## Evidence pointers

- `tests/unit/connector-read-effects.test.ts`: real name matrix and admission boundary.
- `tests/unit/connector-read-hook-migration.test.ts`: executable generated/migrated hook and server parity.
- `tests/integration/trust-governed-effects-routes.test.ts`: real HTTP admission with no read approval cards.
- `tests/e2e/trust-account-path-alive.test.ts`: production server start and runtime reload.
- Before fix: 30 read regressions fail; after fix: 129 focused unit checks, 7 HTTP checks and 2 lifecycle checks pass.

## Class-Closure Declaration (display-only mirror)

Ordinary deterministic parser defect, not prompt-output contract drift (the registry explicitly excludes non-prompt parser bugs). No prompt/config/skill/standards defect or self-triggered controller is introduced. No agent-authored-artifact behavior defect declaration applies; the hook's executable parser is tested through its real generated and deployed-update paths.
