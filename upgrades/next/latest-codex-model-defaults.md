# Latest Reviewed Codex Models for New Sessions

## What Changed

New Codex sessions can follow the latest reviewed model in the Sol or Astra family. Sol is the built-in choice. A saved exact model keeps its priority, and the server logs a warning when a newer reviewed model in that family is available. Changes to the saved default apply to new launches on the receiving computer as soon as the configuration is saved. Existing CLI compatibility and account quota checks still apply.

## What to Tell Your User

New Codex conversations follow the newest reviewed Sol model by default. Choose Astra to follow the newest reviewed Astra model instead. If you pin an exact model, Instar keeps that choice and logs a warning when it falls behind. A change applies to new conversations on that computer. Conversations already open keep their current model.

## Summary of New Capabilities

| Capability | How to Use |
| --- | --- |
| Follow a reviewed Codex model family | Use `latest:sol` or `latest:astra` under `sessions.frameworkDefaultModels`. |
| Keep a specific default model | Enter its exact model ID. The server logs stale-pin warnings. |
| Apply a default without restarting the server | Save the model default through the authenticated config API for that computer. |

## Evidence

Focused model selection, machine coherence, awareness, route integration and lifecycle checks passed. The authenticated lifecycle checks cover live config updates, sibling pins, overlapping writes and failed persistence. Full exact-head verification remains with the release verifier.
