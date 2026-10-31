# Short identity fragments are not names

The live Other agents page showed rows named with eight-character fragments of agent fingerprints. The existing rule rejected full fingerprints but let shortened ones through. A fragment identifies an agent to a machine; it does not tell a person who that agent is.

The shared name check now rejects pure hexadecimal fragments of eight or more characters, optionally followed by an ellipsis, and full UUIDs. An agent with no verified name appears as “Unnamed agent.” The console preview applies the same check, so its rows and headlines use actual names or a clear missing-name state.

Tests cover the shared rule, old and newly saved delivery records, and the console model. A live console-model read reproduced the eight-character labels before the fix and showed “Unnamed agent” afterward. The original topic-name fix remains live on all four active Echo machines.
