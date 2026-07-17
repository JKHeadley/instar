# Fresh-cost token-burn detection

## What Changed

Token-burn shares and rates now exclude cache-read tokens while retaining gross usage in the token ledger.

## Evidence

The detector, ledger, attribution, and verification suites pass 66 focused tests. The build also passes.

## What to Tell Your User

Warm-cache sessions no longer look expensive merely because they reuse a large cached prompt. Burn alerts now track the token work that carries meaningful fresh cost.

## Summary of New Capabilities

Burn share, recent rate, baseline comparison, and projected daily burn all use fresh-cost tokens. Cache creation remains counted because it is cost-bearing.
