# Opus 5.5 is a recognized model name

## What this is

Instar keeps a short list of the Claude model names it will accept. When someone pins a conversation to a model, or sets a default model in the config, Instar checks the name against that list. If the name is not there, the request is refused as an "unknown model" and the conversation falls back to the default, with a one-time notice.

Opus 5.5 was missing from that list. The model itself works fine: this very session runs on it. But a request to pin a conversation to "claude-opus-5-5" was refused. The operator wanted every conversation that had been pinned to Fable 5.1 moved to Opus 5.5, and the only way around the refusal was the short alias "opus", which does not name a specific version.

## What changes

One name is added to the list. Before adding it, we ran the Claude command line with that exact model name and confirmed Opus 5.5 answered. The tests now check that the name is accepted and that it stays in the normal subscription billing lane.

## What does not change

Nothing about which model does heavy work changes, and no default changes. Being on the list only means "Instar will accept this name". It does not mean "Instar prefers this model". Names that were never checked are still refused.

## What you need to decide

Nothing. It is a one-line change that can be undone by removing that line.
