# Verified names, not IDs

Instar uses numbers and fingerprints to route messages to the right topic, channel, machine, or agent. Those identifiers are useful to the software, but they are poor names for a person reading the console. In the reported screen, an agent fingerprint appeared where an agent name should have been, and Telegram conversations sometimes appeared as `topic-127504`. The screen made a failed name lookup look like a real title.

This change makes a title and its ID travel together. Telegram and Slack keep a real title once one is known. A standby machine cannot replace it with a generated placeholder. If a machine does not know a Telegram topic title, the new pooled read asks its peers, giving priority to the machine currently serving Telegram. The answer includes a separate list of unresolved topics and machines that did not answer, so the console can say it cannot tell yet and retry. Forwarding a Telegram message to another machine also looks up the title before starting a session. The message still goes through if the title cannot be found.

The shared display rule rejects obvious identifiers presented as names, including numeric topic IDs, generated `topic-N` labels, fingerprints, and channel IDs. It also applies to peer health and session metadata. Raw identifiers remain available as routing keys and in support details. They do not become headlines or row names. This is a display and identity integrity fix; it does not change who can send, approve, pair, or access messages.

The duplicate-session warning still works after display names are cleaned up: it matches the conversation's platform and ID internally, so a coincidental match between two session keys does not warn about the wrong conversation.

Tests cover the validator, the platform adapters, the pooled HTTP response, migration, and a live server lifecycle. The separate console preview uses the new endpoint and has been checked at phone and desktop sizes. The remaining live check is to see the released pooled response return real names on the operator's machines.
