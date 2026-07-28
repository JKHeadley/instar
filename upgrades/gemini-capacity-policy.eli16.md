# Gemini Capacity Handling — ELI16

Viewable private artifact:
https://codey.dawn-tunnel.dev/view/b5873ea2-17ba-4adf-9d1a-f0e1c48f781e?sig=3e2c7d2f4e0852cf91496f79ce25aeca72ce778c92d3278e101b63bec90400af

Gemini sometimes says, "I'm out of capacity right now; try again after this
reset window." Before this change, Instar treated that too much like an ordinary
failure. The next Gemini call could try again immediately, hit the same quota
wall, and make the agent look stuck. One fallback path also guessed an old model
name, `gemini-2.0-flash`, which Gemini rejected.

This change gives Gemini its own capacity rule. If the reset is short, Instar
waits briefly and tries once. If Gemini gives a longer reset window, Instar
remembers it and refuses later Gemini calls locally until the window passes.
That means no repeated doomed Gemini subprocesses and a clearer error for the
agent/operator.

It also limits Gemini model choices to the verified names we know work:
`gemini-2.5-flash` and `gemini-2.5-pro`. If some code asks for an unknown Gemini
model, Instar falls back to `gemini-2.5-flash` instead of sending a guessed model
to Gemini and getting a 404.
