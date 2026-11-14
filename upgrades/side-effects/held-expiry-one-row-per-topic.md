# Side-effects review: held-reply expiry alerts are one row per topic

## Change
`src/messaging/telegram-origin/OriginForwardToHolder.ts`: new `heldExpiryItem(row)` builds the attention item raised when a held reply expires. The id stays per operation; the new `conditionKey` is `telegram-origin-held:<topic>:expired` (or `unknown`). `src/commands/server.ts` `onHeldForwardExpired` raises that item (same category, priority, title, wording, source, `hubOnly`). With the attention lifecycle on, a later expiry for the same topic lands on the existing open row (occurrences +1, alias recorded, summary refreshed) instead of a new row.

## Evidence
On 2026-11-02 the pooled read `GET /attention?scope=pool&status=OPEN` returned 978 open items (742 KB); 744 were keyless "Held reply to topic N expired" rows (109 for topic 33890 alone), mostly from the Mac Mini, Laptop and Mama PC. The lifecycle could not merge them: their derived keys differ by operation id. The first read after a restart took 25 s, and the console showed "Checking in…" for that long. The held-reply logs (Mini, Laptop) show the expiries were mostly automated job output and stopped after 11-01.

## 1. Over-block
None; nothing is suppressed. Every expiry is still reported once and written to the held-reply audit log with its operation id.

## 2. Under-block
Rows raised before this change (no conditionKey) do not merge with the new keyed row; they age out under the existing 14-day automated window.

## 3. Level-of-abstraction fit
The producer names its condition; the lifecycle's one-row-per-condition rule does the merging, as documented for recurring items.

## 4. Signal vs authority
No decision logic; a notification's grouping only.

## 5. Interactions
`hubOnly` and priority unchanged. The aggregate/held-active items (`HeldForwardItemCollapser`) keep their own ids and keys. The `telegram-origin-held` resolver is unchanged.

## 6. External surfaces
The Attention list shows one expiry row per topic with a count instead of one row per lost message.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
A topic that loses several replies reads as one row with its count, not a wall of identical rows; pooled reads stay small, so Home answers promptly instead of "Checking in…".

## 7. Multi-machine posture
Machine-local attention store per machine, unchanged; pooled read merges them.

## 8. Rollback cost
Revert.

## Class closure
unbounded-self-action: n/a. Changes the grouping key of an existing notification; adds no action, loop or trigger.
