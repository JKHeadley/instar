# Side effects: the per-item attention routing mode is deprecated with a removal date

**Version / slug:** `per-item-routing-retirement`
**Date:** `2026-11-28`
**Author:** `Echo (Telegram Parity, standards countdown STD-SUBCOUNTDOWN-per-item-routing-retirement)`

## Decision and authority

No authority changes. New module src/messaging/attentionRoutingMode.ts: `PER_ITEM_ROUTING_REMOVED_ON = '2027-03-01'` and `resolveAttentionRoutingMode(requested, now)`. Anything other than exactly `'per-item'` is `single-topic` with no notice (unchanged). `'per-item'` before the date is `per-item` with a deprecation notice; from the date it is `single-topic` with a "retired" notice. `TelegramAdapter`'s constructor uses it and logs the notice once with `console.warn`. Routing behaviour before the date is unchanged for every install.

The removal date is this change's proposal. The standards registry article "Notices Route to the Alerts Topic, Never a New One" still calls the sub-obligation unenforced with a 2026-12-21 countdown. docs/STANDARDS-REGISTRY.md is code-owned by the operator, so updating it to cite this enforcement and the date is a separate pull request that needs the operator's approval (owner: Telegram Parity, due 2026-12-11).

## Data and resource effects

One warning line at startup on installs that set the per-item mode; none otherwise (the adapter that reads the setting is built once per server process; the send-only adapter gets no routing config). After 2027-03-01 such an install stops creating a forum topic per attention item, and every item goes to the Attention topic, as on every other install today. This dates and warns; it does not stop a person setting the mode by hand before the date.

Tests: six files exercise the legacy path on purpose (tests/unit/attention-single-topic-routing.test.ts, tests/integration/agent-health-lane.test.ts, tests/integration/attention-topic-flood-guard.test.ts, tests/integration/notification-flood-burst-invariant.test.ts, tests/integration/threadline-verified-pairing-burst-invariant.test.ts, tests/e2e/attention-topic-flood-guard-lifecycle.test.ts). So the suite never turns red on a calendar date, the resolver has a test-only clock (`setPerItemRoutingClockForTests`), and tests/vitest-setup.ts, shared by the unit, integration and e2e configs, pins it to 2026-12-01. The resolver's own tests pass explicit times on both sides of the date. Removing the mode and those tests is the removal work; it is tracked by the registry countdown, which the follow-up registry pull request re-dates to the removal (the countdown lint fails a branch once a countdown expires), owner Telegram Parity.

Agent instructions: src/scaffold/templates.ts (new agents) no longer shows the per-item setting. src/core/PostUpdateMigrator.ts: `SINGLE_ATTENTION_TOPIC_LEAD`, still inserted for agents without a Topic-Flood Guard section, now says the mode is deprecated with its date instead of how to enable it, and a new idempotent step in the CLAUDE.md migration rewrites that old opt-in clause in place in existing agents' files (keyed on the old clause, gone after one run). A new awareness entry, src/data/awareness/per-item-attention-routing-retired.md (Telegram agents), says the same in the feature notes.

Ratchet: tests/unit/per-item-routing-retirement.test.ts counts every quoted `per-item` in every file under src/ and scripts/ and pins the count per file: TelegramAdapter.ts 4 (types and comments), attentionRoutingMode.ts 7 (the resolver), PostUpdateMigrator.ts 1 (the clause it rewrites). Any new use, in any file type, fails the unit suite. The one file skipped is src/data/standards-registry.md, a gitignored build copy of the registry prose. The scan is a plain file walk (the destructive-tool lint refuses a direct git call in a test).

## Rollback and verification

Revert the commit: the per-item mode works with no date and no warning, and the template text returns. Files: src/messaging/attentionRoutingMode.ts, src/messaging/TelegramAdapter.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates.ts, src/data/awareness/per-item-attention-routing-retired.md, tests/vitest-setup.ts, tests/unit/per-item-routing-retirement.test.ts, tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts. Verification on the M5, 2026-11-28, exit 0: per-item-routing-retirement (7), PostUpdateMigrator-topicFloodGuard (5, including the in-place rewrite and its idempotence), attention-single-topic-routing (32, legacy path still passing under the pinned clock), awareness-entry-registry, awareness-entry-registry-consumers (118 tests), and claude-md-core-headroom plus claude-md-reference-layout (40, the instruction size budget). npx tsc --noEmit -p . clean. The integration and e2e files are not run on the M5 by rule; they read the same setup file.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-28 08:41 PT, read only. Verdict: CONCUR WITH CHANGES.

It confirmed the resolver (only the exact string `per-item` changes anything; the date is inclusive at midnight UTC), that the constructor is the only reader of `config.attentionRouting`, and that at most one warning is logged per server start. Applied: the migrator text that still told existing agents how to enable the mode is rewritten, with an in-place migration step; the scan is now an exact per-file count of every quoted per-item, with no file allowlisted; the six legacy-path test files are made independent of the date through the shared setup clock instead of failing on 2027-03-01; the claim that a test generates a config is removed; the awareness title says deprecated; the ELI16 says the warning appears only where the setting is used; and this note now says the change dates and warns rather than prevents.

## Class-Closure Declaration

unbounded-self-action: n/a. No new action: a routing mode is resolved once at adapter construction.

## 6b. Operator-surface quality

No visible surface changes before 2027-03-01, apart from one startup warning line in the server log on installs that use the per-item mode.

## Framework generality

Telegram adapter configuration and agent instruction text. Nothing depends on an agent framework or model provider.
