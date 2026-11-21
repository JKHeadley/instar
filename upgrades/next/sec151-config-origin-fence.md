# The settings API cannot change the public address, relay addresses, agent-network trust, peer-session limits, framework routing or the feedback address

<!-- bump: patch -->

## What Changed

SEC-151. `PATCH /config` and the bearer single-path writer now refuse a shared table of operator-only paths: the named tunnel's token, config file, hostname and relay providers; the threadline relay addresses; the agent-network trust switches (encryption to pinned peers, downgrade refusal, unknown-sender and local-route trust, first-contact policy, the warm-session trust floor); the pipe-mode limits for peer-started sessions; the default framework, component framework routing, enabled frameworks, per-framework default models and nature routing; and the feedback address and file. A body naming a second-level key that holds one of them is refused too, because that route replaces second-level keys whole. The tunnel, relay, feedback and dispatch on/off switches are unchanged.

## What to Tell Your User

- **Public address locked to the settings file**: "The settings interface my tools can use can no longer move my public address or my relay, switch off my checks on other agents, change which AI framework runs, or send my feedback elsewhere. Those now change only in my settings file on this computer."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Tunnel identity, relay addresses, agent-network trust, peer-session limits, framework routing and the feedback address fenced from the settings API | Automatic; set them in `.instar/config.json` |

## Evidence

- `tests/unit/sec151-config-origin-fence.test.ts`: every fenced path is refused for both writers, a whole-subtree replacement is caught, and the feature switches still pass.
