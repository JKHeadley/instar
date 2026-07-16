# Exact topic-profile swap confirmation

After a topic changes framework, model, or model tier, the completion message now names the exact
door and concrete model that the replacement session actually launched. This also covers defaults:
an unpinned Codex topic reports `Codex door, gpt-5.5 model` because that value comes from the same
resolver used to build the Codex command, rather than from the requested profile alone.
