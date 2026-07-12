<!-- bump: patch -->

## What Changed

Three rendering bugs in attention-alert messages, all visible in the operator's 🔔 Attention hub on 2026-07-11 (topic 29836 report): (1) **literal `<b>`/`<i>` tags** — the hub post authors Telegram HTML but sent it through `sendToTopic` without the formatter's `_formatMode: 'html'` opt-out, so the default GFM→HTML converter escaped the tags into visible text (the per-item legacy path already passed it; the hub path was missed). `sendToTopic` now accepts `formatMode: 'html'` and the hub post uses it (`parse_mode: 'HTML'` + `_formatMode: 'html'`, with a plain-param fallback on a rare 400). (2) **Every alert paragraph rendered twice** — episode renderers (machine-coherence, rope probe) build `description` as `${summary}\n\n${...}`, and both hub and per-item posts rendered summary AND description. A shared pure helper (`attentionBodyBlocks`) now renders the paragraph once when description begins with summary. (3) **Raw machine ids in rope alerts** (`m_4cbc0d…` instead of "Laptop") — violating the rope-health contract (rope KIND + machine NICKNAME only). `RopeRecoveryProber` now takes an optional `nicknameOf` dep, wired from the machine registry at the server construction site; fallback stays the raw id (honest) and a throwing resolver can never break the probe loop.

## What to Tell Your User

The alert messages in your 🔔 Attention topic are readable now: no more visible code tags where bold text should be, no more saying everything twice, and connection alerts name your machines the way you do ("Laptop", "Mac Mini") instead of long internal ids. Same alerts, same information — just formatted like a human wrote them.

## Summary of New Capabilities

- `sendToTopic(..., { formatMode: 'html' })` — opt-in for callers that author escaped Telegram HTML, so the markdown converter doesn't re-escape it.
- `attentionBodyBlocks(summary, description, slice)` — exported pure helper deduping the summary paragraph in attention posts (hub + per-item paths).
- `RopeRecoveryProberDeps.nicknameOf` — escalation bodies name machines by registry nickname.

## Evidence

- `tests/unit/attention-single-topic-routing.test.ts` (+3 routed + 5 pure): hub post rides `parse_mode: 'HTML'` + `_formatMode: 'html'`; summary paragraph renders exactly once when description embeds it; independent description still renders both blocks; `attentionBodyBlocks` edge cases (identical, absent, slice bound).
- `tests/unit/RopeRecoveryProber.test.ts` (+3): slow-alive and exhaustion bodies carry the nickname and never the raw id; a throwing nickname resolver falls back to the id without breaking the probe loop.
- Full `tsc --noEmit` clean; 118 tests green across the two extended suites + 7 adjacent telegram/attention suites.
