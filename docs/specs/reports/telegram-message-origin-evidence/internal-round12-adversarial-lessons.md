# Round 12 — adversarial and lessons-aware review

Current spec body SHA-256: `db5114a4916e85540a0c8a7d7b6b14991de4ddeddf5d14c4ddd8b417a17a9e94`. Re-read the new authority/storage anchors, notification and activation contracts, and conformance round 12; rechecked relevant fresh-source notification and self-action machinery. Two perspectives from the same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0.**

The newly named seams do not transfer authority to origin records. SQLite/WAL extends the existing executable entries and fenced claims; retained audit tables, spool records and peer copies remain inert evidence. There is no extra queue product or fallback executor. Worker access and FULL durability explicitly address the existing synchronous SQLite defaults rather than assuming the old constructor already meets them.

The exclusive `TelegramOriginOutageNotifier` permit-consumption boundary, source lint and independent sabotage tests are already explicit. Public caller input remains only an authorized alert-destination identifier. The projection's expiry, observer-health and revocation checks still apply at dequeue; no recovered origin reference or permit can replace policy authority. The new source-anchor table does not authorize calling the retrying hub sender or batcher during an outage.

The activation matrix requires concrete passing tests and real production wiring per contract, sub-obligation, notice invariant and sender family. This complements the existing behavioral controls and prevents a text-only or merely constructed feature from claiming complete activation. No additional defect found.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0.**

Re-grounding confirmed `TelegramAdapter` has `attentionHubTopicId`/`routeToAttentionHub`, whose high-level sender must not be used for the one-attempt outage path; `NotificationBatcher` has topic/ownership limits and its own retry/format behavior, so the explicit new notice pacing cap remains necessary. The spec names these as integration seams rather than claiming their current APIs already implement the notifier.

The new self-action anchor explicitly adds a persistent per-build latch and fifteen-minute brake that remain effective when the governor is observe-only. This preserves the round-10 P22 fix and P19 bounds without treating mere governor registration as enforcement. The bounded read-only recovery still cannot replay an uncertain send. P23 hub routing, P24 disclosed coverage bounds, L5 live browser canaries and the project test/wiring requirements remain covered.

## Counts and scope

Combined: **0 DESIGN, 0 PRECISION**. This is the second consecutive quiet round for these two internal perspectives only; it does not settle the independent external or aggregate convergence result. Earlier findings retain their original classifications. Conformance round 12: 90 standards checked, zero findings, not degraded. No runtime/source edits or external sends. The evidence matrix and authenticated browser activation remain implementation obligations.
