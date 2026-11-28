# Side effects: a build-time ratchet on default-loud notification senders

**Version / slug:** `silent-by-default-ratchet`
**Date:** `2026-11-28`
**Author:** `Echo (Telegram Parity, standards countdown STD-SUBCOUNTDOWN-silent-by-default-emitters, CMT-1901)`

## Decision and authority

No authority or behaviour changes. tests/unit/notification-silent-by-default-ratchet.test.ts checks three things against docs/notification-default-posture-baseline.json, which describes the enforcing gate (with the Quiet by Default gate off or in dry run, today's fleet default, every category is delivered):

1. Loud categories, derived from the shipped sets: DEFAULT_PUSH_CATEGORIES (NotificationSelectivityGate.ts), PROTECTED_DELIVERY_CATEGORIES and SIGNIFICANT_TABLE (notificationCategories.ts), and update-announcement for the release-audience promotion, which is listed by name because it is a branch in the gate's decide, not data.
2. Registered senders into a loud category, from all four sender registries: EMITTER_CATEGORIES and NAMED_EMITTERS (notificationStampers.ts), PRODUCER_NOTIFICATION_CATEGORIES and ATTENTION_FAMILY_CATEGORIES (notificationCategories.ts).
3. Inline envelopes: modules the notification lint trusts (scripts/lint-notification-selectivity.mjs trustedComposition) may build an envelope themselves, outside every registry. The test counts, per file under src/, each literal that makes a send loud (a loud category id assigned to `category`, a `significantClass`, or `releaseAudiencePromoted: true`) and requires the counts to match: 22 literals in 7 files today.

Every baseline entry must carry a reason in `_why`, and `_why` may hold no reason for an entry that no longer exists. `uncategorized` must stay quiet. Source changes: two `export` keywords in src/messaging/notificationStampers.ts (`NAMED_EMITTERS`, `NamedProducer`), and the attention source-family map in src/messaging/notificationCategories.ts moved out of `categoryForAttention` into the exported `ATTENTION_FAMILY_CATEGORIES` (same entries, same lookup).

Limits, stated: the census matches literals, so a loud category passed through a variable (for example a shorthand `{ category }`) or computed is not counted; the lint already confines most minting to registered stampers and named seams. Not derived from data, so a new branch of this kind needs its own entry or review: the verified-reply origin (delivers whatever the category; confined to the reply-minting files by the lint), the gate's own single-use local permits (the daily digest, the overflow summaries and the store-failure attention item push through `routeOnce`; the digest also runs with the digest switched off on a day a disk post was held quiet), and a new early-return branch in decide. A flip of a LEGACY_NOTIFICATION_GATES default (today false, ConfigDefaults) is not caught. Whether a loud default is right stays with review, as the registry article says.

## Data and resource effects

None at run time. One reviewed JSON file in docs/.

## Rollback and verification

Revert the commit. Files: src/messaging/notificationStampers.ts, src/messaging/notificationCategories.ts, docs/notification-default-posture-baseline.json, tests/unit/notification-silent-by-default-ratchet.test.ts. Verification on the M5, 2026-11-28, exit 0: the ratchet (5 tests), notification-selectivity (30), and the other unit files that import the categories or stampers module. Two mutation probes failed the ratchet and were reverted with no diff: a producer into owner-decision, and an inline `category: 'owner-decision'` literal in src/server/notificationRoutes.ts. npx tsc --noEmit -p . clean.

The standards registry article still calls the sub-obligation unenforced; it is code-owned, so citing this ratchet is a separate pull request for the operator's approval (Telegram Parity, by 2026-12-14).

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-28 08:55 PT, read only. Verdict: CONCUR WITH CHANGES.

It found the registry derivation correct and the test failing exactly on new loud entries and stale ones, and the export change safe. Applied: the inline-envelope census (its main finding: trusted modules build loud envelopes outside every registry, so the first Limits sentence was false), the fourth registry (attention source families), a required reason for every entry, and a Limits paragraph that says the baseline describes the enforcing gate and names what is not derived (verified replies, the gate's local permits, new decide branches, legacy gate defaults). Second look (08:57 PT): CONCUR; its two notes applied (the SessionMonitor count is named as a type annotation, and stale reasons now fail).

## Class-Closure Declaration

unbounded-self-action: n/a. No action; a test and a data file.

## 6b. Operator-surface quality

No visible surface changes.

## Framework generality

Notification registries and a unit test. Nothing depends on an agent framework or model provider.
