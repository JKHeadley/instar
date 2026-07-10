# Single Alerts Topic — plain-English overview

## What this change actually is

Right now, every time the agent raises an "attention item" — a heads-up like "a
guard looks off", "a probe failed", "a credential moved" — the Telegram adapter
creates a brand-new forum topic just for that one alert. There is a flood guard,
but it only catches BURSTS (four or more alerts from the same source within ten
minutes). Alerts that drip in slowly — one every few hours, each from a
different feature — sail right past it, and each one still mints a topic. Over
weeks that put ~317 junk topics in the operator's Telegram, drowning the real
conversations. The operator's directive (topic 11960) was blunt: alerts go into
ONE dedicated topic, and NOTHING else, kill the per-item topics.

This change does exactly that. A durable "🔔 Attention" hub topic ALREADY
exists — the server creates it once at boot and remembers its id. The fix makes
`createAttentionItem` post EVERY alert — low, normal, high, and urgent alike —
as a message INTO that hub topic instead of creating any topic. The new default
is `attentionRouting.mode: 'single-topic'`, a code default: existing agents
flip over on their next update with no config edit and no migration.

## What already exists and stays

- The boot-created hub topic and its state key (`agent-attention-topic`) — the
  adapter now reads it through an injected resolver.
- The agent-health lane ("🩺 Agent Health") — already a single reused topic;
  untouched, and it still takes precedence for lane-tagged items.
- The flood guard and the global topic-creation ceiling — fully intact. They
  still protect anyone who deliberately opts back into per-item topics
  (`attentionRouting.mode: 'per-item'`), and every other topic creator.
- The attention store, `/attention` API, and the dashboard — unchanged. Every
  item is still recorded and manageable there.

## The safeguards, in plain terms

- **Nothing is ever dropped.** If the hub id can't be found (fresh install) or
  the send fails (someone deleted the hub), the adapter finds-or-creates the
  hub once and reuses it — it NEVER falls back to a per-item topic, and the
  item is always in the attention store regardless.
- **Resolving one alert can't close the shared hub.** Hub-routed items are
  deliberately kept out of the per-item topic maps, so the /done handler that
  used to close a per-item topic never touches the hub.
- **Rollback is one config key.** `messaging[].config.attentionRouting =
  { "mode": "per-item" }` restores the old behavior byte-for-byte.

## What changed on the "critical alerts" rule

The old rule said HIGH/URGENT alerts always get their own topic so they stay
visible. The directive explicitly retires that: ALL priorities go to the one
hub (each message is prefixed with its priority emoji, so urgency is still
visible at a glance). Tests that pinned the old carve-out now pin it under the
legacy opt-out mode instead.

## What you'd need to decide

Nothing is open. The only judgment call already made: HIGH/URGENT alerts share
the hub too (that is the letter of the directive — "a SINGLE topic … and
NOTHING else"). If a per-item exception for critical alerts is ever wanted
back, it's the one-line legacy mode, per agent.
