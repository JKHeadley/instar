# Side-Effects Review — dashboard result lines and paired-device sections (fb-8c4c5d83-759)

**Version / slug:** `dashboard-ui-layout-fb759`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `not required (layout only; no gate, session, messaging or decision logic)`

## Summary of the change

Tier 1: about 7 runtime files (dashboard JS/CSS only, no `src/`), plus tests and docs. Effort: no spec rounds, one build pass.

1. `dashboard/console/accounts.js` `autoRepairTap`: the result sheet rendered each machine's answer as an inline `span.row-sub` inside a `<p>`, which ran them together (`.row-sub` is only a block inside `.row`). It now sets a one-line summary and appends a `ul.result-list` with one `li` per machine. The new pure helper `resultLines` in `auto-repair-model.js` gives each line its name and outcome. CSS goes in `console.css`.
2. `dashboard-pair/pair.js` + `pair-model.js` + `pair.css`, and the legacy `dashboard/phones.js` + `index.html` CSS: the paired list is split by the new pure helper `pairedGroups` into "Paired phones" and "Paired browsers". Each row is a name plus one detail line, with a non-wrapping "Remove" button (aria-label names the device). `browserWords` (the "Browser · …" tag) and the per-row status words are replaced. The legacy tile label "Paired phones" becomes "Paired devices", because it counted browsers too.
3. `docs/specs/dashboard-ui-quality-standard.md`: a short UI quality standard. Not a constitution file.

## Decision-point inventory

None. No gate, filter or block is added or changed. The revoke call, its confirm prompt and its URL are unchanged.

## 1. Over-block

No issue identified: nothing is blocked. The same active/pending devices are shown, and the same devices are removable (active only).

## 2. Under-block

No issue identified. Devices whose `client` is anything other than `'browser'` are treated as phones, the same as before.

## 3. Level-of-abstraction fit

The grouping and result-line wording are pure model functions next to the existing models (`pair-model.js`, `auto-repair-model.js`), so they can be tested without a DOM. The legacy `dashboard/phones.js` keeps a copy of `pairedGroups` because it is served from a different folder than `dashboard-pair/`. It already duplicated `browserWords` for the same reason, and both copies are tested by the same cases.

## 4. Signal vs authority compliance

Not applicable: display only. See `docs/signal-vs-authority.md`; no decision point.

## 5. Interactions

- `tests/unit/dashboard-phones.test.ts` checks the glance tile by key `paired`, not by label, so the label change is safe there.
- The result sheet still closes and refreshes after 30 s, and again at 60 s. `autoRepairResults` (used by the per-row "Confirmed." line) is unchanged.
- The Pair page keeps its CSP rules: no inline styles, and everything goes through textContent and setAttribute.

## 6. External surfaces

Visible to the operator on the dashboard only. Wording changes: "Paired browsers" heading, short detail lines, "Remove" button text, and the legacy tile "Paired devices". No API, config or stored data change.

## 7. Multi-machine posture

Machine-local by design: these pages render what the serving machine's API returns. The device list is already per machine ("paired with this machine"), and the result sheet already lists every machine's answer from the one configure-pool call.

## 8. Rollback cost

A plain revert. No state, migration or config.
