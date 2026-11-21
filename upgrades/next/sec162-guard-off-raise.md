# Switching a guard off through the settings API needs the owner's approval

<!-- bump: patch -->

## What Changed

SEC-162. The trust-raise check behind `PATCH /config`, the bearer single-path writer and the trust journey now treats switching a guard off as a loosening. A guard is anything the `/guards` inventory lists, plus the input guard and the response review. With only the API token, such a change is answered `403 operator-approval-required` and nothing is written. The owner approves it through the existing trust request card. Weakening a guard that stays on counts too: dry run, an input-guard check off or its action lowered, or response review set to observe-only. The trust request card can now carry these settings, so the owner can approve them. The input guard and response review feature switches open the owner's card too; on a paired phone set up to approve it is one tap. Switching a guard on, and tuning one that stays on, are unchanged.

## What to Tell Your User

- **Guards stay on unless you agree**: "My safety guards can no longer be switched off or weakened through my settings interface without you. If something asks, you get an approval card first. On your phone that is one tap. Switching them on needs nothing from you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Guard-off changes need the owner's approval | Automatic; approve from the trust request card |

## Evidence

- `tests/unit/sec162-guard-off-raise.test.ts`: reproduced the gap first (7 of 10 failed on the old code), then every guard-off path is a raise, switching on stays free, and the affected feature toggles are listed exactly.
