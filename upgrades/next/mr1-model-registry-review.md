# MR1 reviewed model registry and routing pins

## What Changed

Applied the August 18 vendor review to the model registry: current Claude 5 and GPT-5.6 Sol entries are frontier, superseded Claude 4.x and GPT-5.5 entries are retained as non-frontier history, and three capable/default routing pins now name the reviewed current ids. The registry review date was already August 18 and is unchanged.

MR1-B reconciles the proposal with runtime: the two Claude 5 ids established by the vendor selector are accepted by the closed model enumeration, the prior-value expectations and three contradictory notes are corrected, and a new CI ratchet invokes every registered pin's owning resolver. A fresh-and-drift-green pin can no longer pass CI when the runtime resolver returns nothing.

## What to Tell Your User

The agent's capable Anthropic and Codex routes are being updated to the vendors' current frontier models. This is a real routing change, not a documentation refresh, and remains a draft for operator approval. Its runtime closed list and CI checks now agree with the reviewed pins.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Current capable model routing | Once approved, capable Anthropic and Codex requests select the reviewed current frontier ids through the same existing tier APIs. |
| Runtime-resolvable registry pins | CI extracts every registered pin and invokes its owning resolver, refusing missing coverage, empty results, or a mismatch. |

## Evidence

- `npm run lint:model-freshness` passes with every named pin in its reviewed frontier set.
- A temporary Codex pin mutation back to non-frontier GPT-5.5 makes the strict freshness lint fail and name `codex-capable-tier`.
- `npx tsc --noEmit` and the full repository lint pass.
- Required control: temporarily removing Claude Opus 5 from the closed enum executes six runtime-resolution tests and fails the exact Claude tier pin with an empty resolved value; restoration passes six of six.
- Expanded targeted tests: 129 pass and 0 fail across nine files.
- Gemini 3.1 Pro remains unchanged and was verified from public vendor documentation, not from a successful local CLI probe.
