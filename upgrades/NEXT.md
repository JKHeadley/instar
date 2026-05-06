# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

`POST /attention` is now gated by the existing `MessagingToneGate` authority — closing the one outbound user-message path that previously bypassed it. For health-class categories (`degradation`, `health`, `health-alert`, `alert`) the gate is invoked with `messageKind: 'health-alert'` so the existing B12 / B13 / B14 ruleset (jargon-laden internals, suppressed-by-self-heal, no call-to-action) fires before any Telegram topic is created. For other categories the standard ruleset (B1–B7, B11) still applies. When the gate blocks, the route returns 422 in the same shape the other outbound routes already use, and `createAttentionItem` is never invoked — no topic gets spawned, no item gets persisted.

`checkOutboundMessage` gained two additive options (`messageKind`, `jargon`) that are forwarded to the gate without changing existing-caller behavior. The `JargonDetector` is invoked as a signal-only detector when `jargon: true` is requested, matching the pattern `DegradationReporter.gateHealthAlert` already uses for its internal alert path.

The `guardian-pulse` skill template's recommended attention id is now `degradation:{FEATURE}` (no timestamp suffix). Repeated detections of the same feature collapse onto the existing attention item via `createAttentionItem`'s strict-id dedup instead of spawning a new Telegram topic per pulse.

## What to Tell Your User

- **Cleaner attention queue**: "I now run every attention-queue alert through the same plain-English check as my other messages. If something is just background noise, doesn't need your input, or already healed itself, it won't reach you. And recurring versions of the same problem now stay in one topic instead of starting a new one each time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Attention queue gated by tone authority | automatic — applies to every POST to the attention queue |
| Health-alert ruleset on attention items | automatic when category is degradation / health / alert |
| Stable attention id for guardian-pulse | new agents pick this up automatically; existing agents keep using the old id, but the gate above catches their messages anyway |

## Evidence

Reproduction: an instar agent ("Bob") created seven near-duplicate Telegram topics ("Server degraded | Priority: LOW Git conflicts may not auto-r...") in four days for one recurring degradation event — no call to action, jargon-laden header, nothing actionable. Reported 2026-05-05 by Justin in topic 8937 with screenshot showing the topic list.

Verified-after: with `POST /attention` wired through `MessagingToneGate`, identical candidate text returns 422 with `rule=B14_HEALTH_ALERT_NO_CTA` (covered by `tests/unit/attention-route-tone-gate.test.ts`). The route does not invoke `createAttentionItem` on block, so no Telegram topic spawns. The companion `tests/unit/guardian-pulse-skill-stable-id.test.ts` regression-guards the recipe. Pre-push gate ran the full suite (2069 unit tests passed) before push; CI confirmed green on PR #131 before merge.

Side-effects review and second-pass concur recorded in `upgrades/side-effects/attention-tone-gate-and-stable-id.md`.
