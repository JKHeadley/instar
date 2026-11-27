# Native Accounts machine grouping metadata

## Summary

Tier 1. The existing owner-or-bearer Accounts read includes an additive machine grouping key and an explicit presence marker on each returned slot. The machine's current sign-in state and label continue to come from the existing slot projection.

## Authority and compatibility

The grouping key is a stable hash of the existing attributed machine identity. It is for display grouping. Existing sign-in APIs still require the original account and machine identity and their existing proof. This change adds no way to resolve an action from the grouping key and changes no route access or cache scope. A missing identity produces a null key. Clients can fall back to provider or ungrouped display on earlier releases. No synthetic slots or raw IDs are added.

## Multi-machine behavior and rollback

Slots keep the machine already attributed by the account pool. A local slot without a canonical identity uses the pool's local ID only when known. Display names are independent of the grouping key. Reverting drops the optional fields and leaves the authorization paths and stored account data intact.

## Independent review

Concur with the review. Reviewer `/root/accounts_layout_review` verified the additive read shape, stable opaque key, and unchanged action authority. The grouping key uses its own normalization so existing repair and blocker lookups keep their behavior.

## Evidence

Focused verification passed all 49 unit tests, 18 signed HTTP integration tests, and one production native Accounts lifecycle test. The signed HTTP coverage verifies that the grouping key appears on a real slot and raw IDs stay out of the response.
