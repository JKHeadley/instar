# Quota Snapshot Hardening

## Problem

Two quota failures were visually indistinguishable from ordinary temporary
collection gaps:

1. malformed credential JSON resolved to `null`, so the poller silently skipped
   an account that required a new login;
2. persisted quota snapshots remained readable indefinitely without saying
   that their `measuredAt` value was old or invalid.

## Contract

1. The non-blocking credential reader exposes a typed `unparseable` result
   without returning or logging the raw blob.
2. The default quota token resolver maps that result to
   `unparseable-credential-blob`.
3. The poller marks the account `needs-reauth` for that result. Missing or
   temporarily unreadable credentials retain the existing retry behavior.
4. `GET /subscription-pool/:id/quota` returns `staleSnapshot` and
   `snapshotAgeMs`.
5. A snapshot is stale after 30 minutes (two missed default 15-minute polling
   cadences), or immediately when `measuredAt` is missing or invalid.
6. No snapshot is represented as `staleSnapshot: false`; absence and staleness
   remain distinct states.

## Security

Failure results contain only a closed reason enum. Credential contents do not
cross the resolver boundary, enter logs, or appear in HTTP responses.
