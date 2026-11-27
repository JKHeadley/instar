# Side-effects review: Secrets page groups saved Secret Drop entries

## Change
`dashboard/console/secrets-model.js` `buildKeys()`: names matching `secretDrops.<16+ hex>` (a saved Secret Drop's storage token, often with "(+N nested)") are replaced by one counted line, "Saved Secret Drop submissions (N)". Other names unchanged. Console display only; the session-start key list (`BootSelfKnowledge`) is untouched.

## Evidence
On the Studio (2026-11-02) the Secrets page listed several `secretDrops.<64-hex> (+5 nested)` rows; the raw-id scan of every console page flagged them as long hex ids.

## 1. Over-block
A real vault key literally named `secretDrops.<hex>` would be counted rather than listed; none exists by convention.

## 2. Under-block
None.

## 3. Level-of-abstraction fit
Display-only; the agent still needs the full names at session start.

## 4. Signal vs authority
No decision logic.

## 5. Interactions
None.

## 6. External surfaces
Secrets page list reads as names.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
The "keys I hold" list no longer shows 64-character tokens that wrap on a phone; saved drops are one line with a count. No values or lengths are shown, as before.

## 7. Multi-machine posture
Per-machine read, unchanged.

## 8. Rollback cost
Revert.
