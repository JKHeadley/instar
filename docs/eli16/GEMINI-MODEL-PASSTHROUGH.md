# Gemini Explicit Model Names

Instar lets a caller pick a framework and a model. Some names are simple tiers, like fast or capable. Those should be translated into the right model for the selected framework. But if an operator gives a concrete Gemini model name, Instar should not silently replace it with a safer default just because the name is not in our small known list.

The previous Gemini session-launch resolver did that replacement. If the model name was not one of the two verified Gemini names, it quietly swapped the request to the default flash model. That hid mistakes, but it also ignored intentional overrides for newer or experimental Gemini models.

This change keeps the safe mapping for generic tiers, but passes explicit Gemini model names through to the Gemini CLI. If the model is bad, the Gemini CLI fails loudly with a provider error. That is better than silently running the wrong model.

Automatic capacity fallback remains constrained to known-good Gemini models. The boundary is: explicit caller intent passes through; automatic fallback choices stay on the verified list.
