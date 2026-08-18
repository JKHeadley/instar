# MR1 reviewed model registry and routing pins

## What Changed

Applied the August 18 vendor review to the model registry: current Claude 5 and GPT-5.6 Sol entries are frontier, superseded Claude 4.x and GPT-5.5 entries are retained as non-frontier history, and three capable/default routing pins now name the reviewed current ids. The registry review date was already August 18 and is unchanged.

This draft also records two merge blockers rather than hiding them: Claude Opus 5 is absent from the tier-escalation closed model enumeration, so the new default resolves to no model; and three unchanged manifest notes contradict the reviewed values. This pull request must not merge until those inconsistencies are explicitly authorized and resolved.

## What to Tell Your User

The agent's capable Anthropic and Codex routes are being updated to the vendors' current frontier models. This is a real routing change, not a documentation refresh. The draft is held from release because one Claude route is currently refused by an independent safety list and some registry notes still describe the old choices.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Current capable model routing | Once the blockers are resolved and the change is approved, capable Anthropic and Codex requests select the reviewed current frontier ids through the same existing tier APIs. |

## Evidence

- `npm run lint:model-freshness` passes with every named pin in its reviewed frontier set.
- A temporary Codex pin mutation back to non-frontier GPT-5.5 makes the strict freshness lint fail and name `codex-capable-tier`.
- `npx tsc --noEmit` and the full repository lint pass.
- Targeted tests: 120 pass and 3 fail. One failure proves the Claude Opus 5 closed-enumeration blocker behaviorally; two are value-pinned expectations for the prior ids.
- Gemini 3.1 Pro remains unchanged and was verified from public vendor documentation, not from a successful local CLI probe.
