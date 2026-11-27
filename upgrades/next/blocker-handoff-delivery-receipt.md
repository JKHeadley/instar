# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The blocker ledger can now require proof that an ask was really delivered before it accepts that something is a true blocker. When the new delivery-receipt store is supplied, a settle must name a persisted, delivered receipt for the same blocker, sent after the failed attempt, and the request time comes from that receipt. Without the store, nothing changes. This is the first piece of the approved blocker hand-off specification, and it ships dark.

## What to Tell Your User

Nothing changes yet. This is groundwork so that, later, I can only treat something as truly needing you after I have actually asked you, which keeps me from claiming I asked when I did not.

## Summary of New Capabilities

An optional delivery-receipt check for true-blocker settles (`deliveryReceiptStore` on BlockerLedger), with refusal code `missing_delivery_receipt`.

## Evidence

Six new unit cases cover both sides of every refusal. All five unit files that use the ledger pass (49 tests).
