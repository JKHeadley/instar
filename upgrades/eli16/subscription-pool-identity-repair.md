# Subscription pool identity repair

## ELI16 overview

A subscription slot has a human label, but the login token inside it is what
proves which account it really belongs to. Previously, quota polling could trust
the label after the token had changed, credit usage to the wrong account, and
later swap a session toward the wrong login.

Now the live token identity wins. Identity checks reuse the profile oracle and
are cached for roughly six hours during polling. A mismatch becomes visible as
`identityDrifted`, the affected labelled account is excluded from capacity and
swap selection, and quota is credited to the account the token proves.

Confirmed drift starts an audited repair pass. Operators can inspect the dry-run
plan at `GET /credentials/repair-plan`; execution uses the existing staged swap
executor, including identity verification and quarantine on uncertainty. Every
swap also performs a fresh, uncached identity pre-flight before any credential
write. Duplicate copies retain the correctly labelled home and vacate the
impostor through staged escrow. If the needed login does not exist locally, the
system opens one durable owner re-login commitment and points to the local
enrollment flow—Claude login tokens are never copied between machines.

The episode closes automatically when a later poll proves that the slot label
and live identity agree again.

The repair remains behind the existing credential re-pointing dark and dry-run gates.
