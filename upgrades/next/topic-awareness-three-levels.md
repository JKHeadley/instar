# Three temporal awareness levels for long conversations

<!-- bump: minor -->

## What Changed

Long-running Telegram topics now carry three simultaneous orientation views:
the whole topic, the most-recent conversational arc, and the work happening
right now. Each view names its goal, trend, and themes. The whole-topic view
keeps the earliest user-grounded goal as a durable landmark while allowing a
separate evolving goal to change as the conversation legitimately moves.

The projection is stored beside Topic Intent's confidence-scored evidence, so
it does not create authority or decay with ordinary goal notes. New arc
boundaries require exact words from a user; subtle boundaries need two
consistent user turns. Out-of-order background completions cannot roll the
projection backward or let a later turn claim to be the initial anchor. A
bounded reorder journal also inserts delayed earlier boundaries at the right
turn and re-homes later-created refs, while both the journal and retained arc
history remain hard-capped.

The awareness briefing is delivered both on a new Telegram prompt and after
compaction recovery. Existing installations receive the same hook behavior as
clean installs. When extraction misses more than two user turns, the briefing
says it is stale instead of presenting old orientation as current.

## What to Tell Your User

- “In a long Telegram conversation, your agent can now keep the original goal,
  the latest chapter, and the immediate work visible at the same time. Each
  level shows its goal, direction, and themes, and stale background tracking is
  called out plainly.”
- “No setup is required. Existing agents receive the briefing delivery update
  automatically.”

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Whole-topic orientation with a durable opening landmark | Automatic on substantive user turns |
| Guarded recent-arc transitions | State a clear change of phase, or establish the subtler shift across two user turns |
| Independent current-work view | Automatic in the Topic Intent briefing |
| Honest freshness and out-of-order protection | Automatic; stale state is labelled and older completions are refused |
| Prompt and compaction delivery parity | Automatic on clean installs and upgrades |

## Evidence

Focused unit, integration, and end-to-end tests cover complete-field refusal,
anchor durability beyond ordinary goal decay, explicit and implicit arc
transitions, agent-only refusal, out-of-order boundary insertion and ref
re-homing, state caps, stale-turn counting, briefing rendering, capture metrics,
and executed canonical/generated hook success/failure parity. The TypeScript
check and repository lint suite pass.
