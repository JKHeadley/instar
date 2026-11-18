# Jev prompt-detect join fix — plain-English overview

## What this change is

When a session's terminal looks like it might be waiting on a question, PromptGate asks a model "is this a blocking prompt?". Beside that, a small, cheap model called Jev answers the same question in shadow (it never acts). To learn whether Jev would be safe to trust, each Jev answer has to be matched with what really happened in the terminal afterwards. That match uses one shared id: the id the router gives the PromptGate call.

On a multi-machine agent that id starts with the machine's short name, for example `d-m_03b30f-...`. The check that decides whether an id is well-formed only allowed letters, digits and dashes, so it rejected the underscore in `m_03b30f` and silently left the id off every Jev row. On the Studio, 0 of 77 real Jev rows could be matched with their outcome. The earlier tests passed only because test installs have no machine name, so their ids have no underscore.

## What already exists

The router mint, PromptGate's outcome rows, the Jev shadow point and the provenance log are all unchanged in behaviour. Outcome rows were already recorded correctly; only the Jev side lost its half of the key.

## What is new

1. The id check now accepts every id the router and breaker can mint, including the underscore. It still rejects spaces, quotes, slashes, dots, other prefixes and anything over 100 characters.
2. Each Jev row also records the model name Jev's server actually answered with (`jevServedModel`), next to the model that was asked for, so a silent vendor rename would show in the log.
3. Tests now use a real multi-machine id, so this kind of drop cannot pass again unnoticed.

## Safeguards

Nothing here decides anything or blocks anything. Jev stays in shadow; PromptGate's actions, prompt and model are unchanged. A revert puts the old behaviour back exactly.

## What you need to decide

Nothing. This is a bug fix inside an existing measurement.
