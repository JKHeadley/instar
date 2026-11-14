# Side-effects review: attention alerts name topics and machines, never their ids

## Change
`nameIdsInText(text, resolvers)` in `src/messaging/shared/channelIdentity.ts` rewrites "topic 123" / "Topic #123" / "Conversation telegram:123" / "telegram:123" to the topic's name, and "Machine m_…" / "m_…" to the machine's nickname. Names pass the existing `verifiedEntityName` rule; an id with no verified name is left as written. `TelegramAdapter.createAttentionItem` applies it to every item's title, summary and description before admission (the one chokepoint every alert passes through). The server wires a machine-name resolver from the pool registry on both Telegram startup paths (polling and send-only). In `admitAttentionObservation`, a stored row is compared after the same naming, so a row first stored with a raw id is renamed quietly instead of being re-posted as a changed ask.

Sixteen producers built titles from raw ids (OwnershipReconciler pin waits, SessionReaper duplicates, PeerVisibilityGuard machine reachability, autonomous re-registration, held-reply expiry, working-set recovery). They are fixed by the chokepoint, and any future producer is too.

## 1. Over-block
None. Not a gate.

## 2. Under-block
An id with no known name stays an id (correct: never invent a name). Ids in other shapes (for example a bare number with no "topic" word) are not rewritten, to avoid renaming counts or durations.

## 3. Level-of-abstraction fit
Attention creation is the single funnel for operator alerts; the name lookup already lives on the adapter (topics) and the pool registry (machines). Correct layer.

## 4. Signal vs authority
No decision point. Text only.

## 5. Interactions
`id` and `conditionKey` are untouched, so dedup, clearing and lifecycle keep working. The comparison for "the ask changed" uses the named form of the stored text, so the rollout does not re-post every open alert. Topic name lookup is the in-memory registry (no network call).

## 6. External surfaces
Alert text in the Attention topic and on the dashboard reads "Topic "Instar dashboard makeover"'s pin…" and "Mac Studio is flapping" instead of numbers and machine ids.

## 7. Multi-machine posture
Each machine names its own alerts from its own topic registry and pool registry view. Machine-local by design; the pooled attention view shows each machine's already-named text.

## 8. Rollback cost
Revert the commit. Stored alerts keep their named text, which is harmless.

## Evidence
On the Studio, 279 open alerts include titles such as "Topic 28730's pin has waited 2892h unfulfilled", "Machine m_cc2ec651a91f03f85abb19bfe5e7e8f7 is flapping" and "Conversation telegram:61449 keeps re-duplicating".

## Class closure
unbounded-self-action: n/a. Text-only change; no self-triggered action is added. A naming-only difference now suppresses a repost rather than causing one.
