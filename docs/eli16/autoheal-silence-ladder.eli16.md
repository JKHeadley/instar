# ELI16 — Auto-heal ladder for silently-stalled sessions

## The problem in plain words

Sometimes one of the agent's work sessions is *running* but has gone quiet —
it was clearly in the middle of a task, then just stopped producing output. A
human watching the chat can't tell the difference between "it's thinking hard"
and "it's wedged and never coming back." Worse, the only thing the system did
about a confirmed stall was send a message asking the operator: *"this went
quiet — want me to dig in?"* That puts the work back on the person, who then has
to notice the message, decide, and tell the agent to restart it. If they're
asleep or away, the stalled session just sits there dead for hours.

The operator's ask was blunt: **don't just tell me it's stuck — fix it, then
tell me.** And: send that notice to the topic that actually stalled, not some
shared firehose channel where it gets lost.

## What this change does

It upgrades the existing "session went silent" watchdog (the
ActiveWorkSilenceSentinel) with a small recovery **ladder**:

1. The session goes quiet past the threshold → the watchdog gives it a gentle
   nudge (press Enter), exactly like before.
2. If the nudge wakes it up → done, nothing else happens.
3. If the nudge does **nothing** and the session is confirmed stuck → instead of
   only asking the operator, it **respawns the session fresh** (a clean restart
   that keeps the conversation via `--resume`), then posts a short note in that
   session's own topic: *"it was stuck — I recovered it, conversation preserved."*
4. If the respawn itself fails → it falls back to the old behavior: ask the
   operator to dig in. And it remembers it already tried, so it never gets stuck
   in a restart-loop hammering the same session over and over.

## The safety rails

- **It ships dark.** The auto-respawn is OFF by default (`autoRecover: false`).
  Turn it on per-agent in config. With it off, behavior is the old "nudge then
  ask" — nothing restarts on its own.
- **It can only restart once.** A counter (`maxAutoRecoveries`, default 1) caps
  how many times a single stuck session is auto-respawned before it gives up and
  asks the human. A respawn that doesn't fix things leaves a "recovery-failed"
  marker that stops the watchdog from re-detecting the same session — that's the
  loop-stopper.
- **Notices go to the right place.** Silence and recovery messages now land in
  the stalled session's own Telegram topic, falling back to the consolidated
  alert channel only if that topic can't be resolved or delivery fails.

## Why it's safe to flip on later

The respawn primitive is the same one the ContextWedgeSentinel already uses to
recover a poisoned session — it's well-tested and framework-agnostic (it
restarts whatever framework that session runs). Promotion to default-on follows
the graduated-rollout track: flip the runtime default and add the persisted
config so existing agents inherit it on update.
