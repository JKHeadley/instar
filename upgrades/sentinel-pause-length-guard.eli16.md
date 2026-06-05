# A long working message ending in "stand by" can no longer be eaten as a pause command

The message sentinel reads every inbound message and classifies it: normal conversation, a redirect, a pause command, or an emergency stop. Pause and emergency-stop classifications are intercepted — the session is paused or killed, a confirmation is posted, and **the message itself is consumed**, never delivered. That's correct for "stop everything": the message IS the command.

The failure: a ~200-word mentor coaching message — task status, instructions, and a closing "…report the numbers back here and stand by" — was classified as a **pause command**. The session paused, "Session paused. Send a message to resume." was posted, and the entire message vanished: not in any queue, not in any drop ledger, just gone. It happened twice in one afternoon on the same topic (14:22 and 14:41), both times on messages ending with "stand by". The classifier's prompt already asks for exactly the right judgment ("substantive content means NORMAL") — but a closing imperative intermittently wins anyway, and a prompt instruction is willpower, not structure.

The structural guard: a **pause** classification on a message longer than 25 words downgrades to normal pass-through, with the downgrade logged and recorded in the classification's reason. The rationale is an asymmetry the prompt itself already encodes:

- **Emergency-stop is untouched.** Stopping unnecessarily on a long panicked message is a tolerable false positive — safety first, always.
- **Pause is politeness, not safety.** Consuming a long message to be polite destroys real content for zero protective payoff. A genuine natural-language pause directive ("hold on, wait for me to finish reading before you continue") is well under 25 words; nobody writes a 200-word pause command.

The fast-path layer needed no change — its existing 4-word gate already keeps long messages away from pattern matches. Slash commands (/pause, /stop) are exact matches and unaffected. Four tests pin the boundary: long pause downgrades, short pause still pauses, long emergency-stop still stops, and the exact 25/26-word edge.
