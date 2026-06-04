<!-- bump: patch -->

## What Changed

Fixed the in-session server lifecycle guard so it only blocks the current
session's own managing server. Restarting a sibling agent server by target
directory or agent name is now allowed from inside a session.

Self-targeted server lifecycle commands are still blocked, and the error now
points operators to the supervisor path for bouncing that agent safely.

The CLI import shape remains compatible with the version-detection regression
test, and the exported guard is documented so docs coverage stays above the core
floor.

## What to Tell Your User

- **Sibling agent restarts**: "I can now bounce another agent's server during
  mentoring or fleet maintenance without being blocked by my own session guard.
  My own managing server is still protected, so the active conversation is not
  stranded by accident."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart a sibling agent server from inside a session | Use the existing server lifecycle command with a sibling target |
| Safer self-server failure message | Automatic when an agent targets its own managing server |

## Evidence

Reproduced the failing shape in a unit boundary test: a session with current
project Codey and target Gemini now returns allow, while current project Codey
targeting Codey still returns reject. The same targeted suite also verifies that
a symlink pointing back to Codey is rejected after realpath normalization. The
targeted server command test file passes with all ten tests green.
