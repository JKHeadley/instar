# Side-Effects Review for First Claim Disk Estimation

The internal staging preflight can request first-claim sizes from the fixed reader after full stream verification. Staging compares the resulting destination with the sealed preview and uses explicit caller policy to estimate physical bytes. The response is bound to the checked request and first file.

## Over-block

A stale destination, missing store, failed reader or exhausted policy ceiling refuses the estimate. Ordinary preflight remains available for an absent store. A changed destination still requires a new prepared selection before estimating.

## Under-block

The estimate is a point-in-time observation under the caller's explicit policy. No live volume, bootstrap margin or filesystem space is reserved here. A future writer must verify exact current inputs and reserve space before issuing permission.

## Abstraction fit and interactions

The fixed reader validates every artifact and reports bounded inputs. Staging owns the two intent checks and sealed destination comparison. The physical estimator applies block rounding, SQLite forward and rollback passes, journal allocation and explicit metadata headroom. Default preview receipts keep their existing shape. The existing reader can use private writer-lock metadata.

## Signal versus authority

Under docs/signal-vs-authority.md, exact preview and operation bindings are protocol facts. Estimates are resource inputs and grant no consent or authority to copy.

## External surfaces and machine scope

There is no HTTP, schema, route, app control or production default. The calculation stays on the chosen machine and returns no message data. No cleanup retirement is introduced.

## Rollback

Reverting removes only the internal estimate path. It creates no new persisted state.

## Class-Closure Declaration

The unbounded-self-action class does not apply. The estimate uses one explicit existing worker invocation and adds no retry or new controller.

## Independent Review

The reviewer concurred with the bound intent, policy snapshot and separation from write authority. The reviewer inspected source and tests without running them.
