# A rollout ladder for meetingTranscript (ELI16)

Every switched-off feature in Instar has a "ladder": a written plan for how it moves from development agents to every agent, and what evidence has to show up first. A test checks that any design document naming a ladder points at a real one. This design document named "meetingTranscript", but nobody had written that ladder down yet, so the test failed and the change couldn't merge.

This adds the missing ladder. It copies the plan the design document already describes: the feature stays dark on the fleet until it has enough clean real uses (2), with no errors, over a two-week soak. Nothing runs differently today, because the feature itself isn't built yet. When someone builds it, they'll find the ladder waiting, and they need to make the feature record a line each time it runs and each time it fails, so the board can measure it.
