# Side-Effects Review — standalone Playwright seat lease

**Version / slug:** `playwright-standalone-seat-lease`
**Date:** `2026-07-16`
**Tier:** 2
**Second-pass reviewer:** independent Codex collaboration reviewer — concur

## Summary

Adds an ownership-checked release operation to `PlaywrightSeatLease`, an authenticated
release route, and a `playwright-seat` CLI acquire/release path so trusted standalone
Playwright scripts can participate in the existing host-wide lease.

## Decision-point inventory

- `PlaywrightSeatLease.release` — **add** — removes the record only for the current holder.
- release route — **add** — returns conflict for a different live holder.
- CLI acquire/release — **add** — exposes the same store to standalone local scripts.

## Over-block / under-block

The existing default-seat lease still conservatively serializes all users of that
physical seat. Standalone scripts remain voluntary participants: a script that ignores
this interface can still contend. This change does not pretend to sandbox hostile or
uncooperative local processes.

## Abstraction and authority

Release belongs in the existing lease store and uses its existing filesystem lock;
the CLI and route are adapters, not second authorities. Ownership is an exact invariant,
not an inferred signal. A mismatched holder cannot release, and an absent record is an
idempotent success for cleanup. Callers must choose a unique ID per active drive
invocation and reuse it only for that invocation's matching release; intentional ID
reuse is intentional same-owner renewal semantics.

## Interactions and races

Acquire and release serialize on the same lock. The ownership check and unlink happen
inside that critical section, preventing a late cleanup from deleting a successor's
lease. No scheduler, retry loop, notification, or external operation is added.

## External surfaces and cross-machine posture

The new route is authenticated and the CLI is local. Both expose holder labels and
expiry already present in the acquire surface; no browser credentials or page data are
read. The state remains **machine-local by design** because the guarded browser profile
is a physical resource on that machine.

## Rollback

Revert the adapters and release method. Existing lease records remain compatible and
expire normally; no migration or repair is required.

## Verification

- TypeScript typecheck
- 39 focused unit/integration tests covering ownership mismatch, successful release,
  idempotent cleanup, successor acquisition, route behavior, and registry classification

## Second-pass review

**Verdict:** concur. The reviewer confirmed that release ownership checking and unlink
are atomic under the same host-wide lock as acquire; route authentication/write
classification, CLI conflict behavior, and machine-local posture are sound. The review's
nonblocking precision note — explicitly require a unique holder ID per invocation — is
incorporated in CLI help, docs, and this artifact.
