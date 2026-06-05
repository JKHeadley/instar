# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Self-health notices now land in ONE calm "🩺 Agent Health" topic instead of spawning
a new Telegram topic per event. Previously the StaleSessionBackstop raised a HIGH
"Session topic-N is stale but unkillable" attention item every stall episode, and
because HIGH bypasses the topic-flood guard, each spawned its own forum topic — a wall
of cryptic, unnamed, non-actionable threads (one agent had 54 of 116 topics that were
this kind of auto-generated noise).

The fix is a delivery-shaper in the messaging layer: an attention item may now opt into
`lane:'agent-health'`. Lane items route into a single, persistently-named lane topic
from the very first item, never spawn their own topic (even if mis-tagged HIGH), and
same-session re-escalations are suppression-deduped within a window. The StaleSessionBackstop
now emits into that lane at NORMAL priority with a topic-name-resolved, reply-able
message ("Heads-up on the 'EXO 3.0' session … reply 'check EXO 3.0' …" instead of
"Session topic-19077 is stale but unkillable"). Nothing is gated or dropped — every
notice is still in the attention store.

## What to Tell Your User

Your agent's routine self-health heads-ups — like "a session looks stuck" — now collect
in one calm, named "Agent Health" topic instead of creating a fresh topic every time.
Each one names the session in plain language, ends with a next step you can just reply
to, and repeats are bundled so the topic stays quiet. It is on by default and never
blocks anything. If you'd rather have the old one-topic-per-notice behavior, you can turn
the lane off in your config.

## Summary of New Capabilities

- A calm "🩺 Agent Health" lane: self-health attention items (opt-in via the lane field)
  route into one named topic, never topic-after-topic.
- Suppression-dedup: the same session re-escalating within the dedup window is recorded
  but not re-posted, so the lane stays quiet.
- Named, actionable notices: the StaleSessionBackstop heads-up resolves the human topic
  name and ends with a reply-able next step, at NORMAL priority.
- Tunable via messaging config (enabled / topicName / maxTrackedKeys / dedupWindowMs);
  default-on, set enabled to false for the prior behavior.

## Evidence

- Unit (tests/unit/stale-session-backstop.test.ts): the escalation is lane-routed,
  NORMAL, keyed per-session, names the topic (never topic-N), and carries a reply CTA.
- Integration (tests/integration/agent-health-lane.test.ts): a real TelegramAdapter
  routes N self-health notices into exactly ONE lane topic, sends HIGH ones to the lane
  too, suppression-dedups same-key re-escalations (intro + one line, rest audited), and
  leaves non-lane items untouched.
- E2E (tests/e2e/agent-health-lane-route.test.ts): over real HTTP, POST /attention
  carries lane+healthKey through and lane items bypass the per-topic tone-gate (still
  delivered even when the gate would block), while non-lane items still run the gate.
- 95 related tests green (incl. the flood-guard + tone-gate suites); tsc clean;
  pre-push-gate clean.
