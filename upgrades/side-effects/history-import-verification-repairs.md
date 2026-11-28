# History Import Verification Repairs

Tier 1: small reversible repairs found by the required full suite while reconciling personal history acquisition with current main. Two implementation files and three test files, plus documentation. One fresh-eyes review found no concrete issue. No feature is enabled by this change.

## Problem and evidence

The exact merged head dad3ba150 failed the silent-fallback ratchet: 494 catches against a baseline of 493. An exact base-versus-candidate scanner comparison isolates the extra catch to importedHistoryRoutes startup staging recovery. Its optional logger can be absent, so failed cleanup has no guaranteed report. A new integration assertion reproduced that omission (zero reporter calls). Reporting uses a fixed feature name, fixed explanation and the error code, never a private path or raw error message. It remains internal observability and does not create another user alert.

The same full suite failed the existing gitignore idempotency test: `.instar/imported-history/` appeared twice on the first write. Two merged lists contain that entry and filtering against the old file cannot remove duplicates within the new additions. Deduplicating the candidate entries before filtering preserves ordering and every exclusion. The existing test checks both exact occurrence count and real git check-ignore behavior, including sibling paths.

## Decision points and principle

Reference: docs/signal-vs-authority.md. Cleanup reporting is a signal, with no new blocking authority. Directory validation and all import permissions remain unchanged. Set deduplication operates on exact configuration strings, not a behavioral classifier. No new user decision is introduced.

## Over-block and under-block

Neither repair rejects additional requests or excludes additional file paths. Cleanup still cannot repair an unsafe directory automatically; the report makes that existing refusal visible. Existing duplicate lines already on disk are retained rather than rewriting user configuration. Only newly generated additions are deduplicated.

## Layer fit and interactions

The route owns recovery and its degradation signal. The existing gitignore writer owns addition idempotency. Existing route logging is retained. The reporter is internalOnly so this signal does not create a second user-facing alert. No new controller, timer, retry, worker or cleanup authority is added.

## External and operator surfaces

No new endpoint, configuration, capability or UI. No raw private message, filename or path is reported. The integration test uses synthetic temporary state and restores its singleton spy. No live owner data is touched.

## Multi-machine and team posture

Cleanup concerns the existing machine-local private import staging directory; no replication is added. Gitignore generation protects each local checkout independently. Owner/member permissions and selected-machine custody do not change.

## Rollback

A source revert undoes these repairs. No data migration or user-state deletion is needed. Existing private data remains excluded and directory validation remains in force.

## Verification

Red: startup cleanup regression test failed with zero reporter calls; existing gitignore test failed with two entries. Green: 33 unit checks and 10 HTTP integration checks passed. Independent review_import_verification_repairs found no concrete issue. Four production lifecycle tests passed, including unsafe staging with successful signed owner history reads. The SQLite wiring allowlist now accounts for the existing registered acquisition store, registered worker lease and transaction-scoped writer handle; no handle implementation changes. Ordinary full verification remains required. No passing full-suite or published result is claimed.

## Provider proof lookup failure

The signed capability route already withheld providers when their proof lookup threw. That exception now emits a fixed internal diagnostic through the existing degradation reporter. The response continues to return an empty provider list. The diagnostic contains a fixed reason and describes the affected operation. Accounts, provider errors and archive data stay within the lookup.

The route already owns the safe response, and the reporter provides visibility. Expected outcomes such as an absent connection or insufficient owner custody continue through their normal branches. The change adds no provider request, permission, retry or enrollment action. The diagnostic is machine-local to the lookup. A source revert restores the previous reporting behavior without a migration.

The focused signed HTTP test establishes the failure with an injected synthetic error and checks that the diagnostic excludes that error. The unit ratchet and history chat unit tests passed after the repair.
