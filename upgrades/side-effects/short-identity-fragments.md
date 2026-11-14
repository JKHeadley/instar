# Side-effects review: short identity fragments

## Trigger and change

After the global verified-name release, the live Other agents consumer still rendered several eight-character hexadecimal fingerprint fragments as agent names. `docs/UX-AND-AGENT-AGENCY-STANDARD.md` Rule 7 already forbids shortened hashes as names. The shared validator rejected hex strings only at sixteen characters or longer, and the console preview copied that threshold. This change lowers the threshold to eight characters and rejects full UUIDs; the console preview receives the matching rule in its separate review branch.

## Risk review

1. **Over-block:** A real agent deliberately named a pure eight-character hex string, a UUID, or such a string followed by an ellipsis will be shown as unnamed. This is consistent with the user's rule that an identifier-looking label must not stand in for a verified name. Ordinary names such as `b2lead-insights` remain valid.
2. **Under-block:** Other arbitrary code formats can still resemble IDs. The rule covers the observed fingerprint fragments and common full UUID form. Missing names remain explicit, so an unrecognized code is not silently invented by this change.
3. **Abstraction:** The shared `verifiedEntityName` function is the correct boundary for stored and served agent names. The console's `verifiedDisplayName` is the final display boundary for legacy or independently sourced rows. Both protect the consumer.
4. **Signal and authority:** This rule changes only the display label. It never blocks routing, pairing, delivery, or trust decisions; IDs remain available internally. It complies with `docs/signal-vs-authority.md`.
5. **Interactions:** `A2ADeliveryTracker` sanitizes names both when writing and when reading old rows, so the new rule filters existing bad data without a destructive migration. The console preserves the agent row but labels it “Unnamed agent.”
6. **External surfaces:** Agent names in delivery health and the console may become “Unnamed agent” where a short hash was previously shown. No identifier, credential, or routing state changes.
7. **Multi-machine:** The code ships through the Instar package to each machine. Names remain paired with fingerprints in the tracker; an unresolved label is explicit on every machine. The console preview uses the pooled server reads and its own final display check.
8. **Rollback:** Reverting the validator restores prior labels without data repair. Old saved rows were never deleted or rewritten.

## Consumer evidence

Before the change, a live console-model read returned names including `237407fc`, `8c7928aa`, and `b805915c`. After the preview validator change, the same read returned real names and “Unnamed agent” for those rows. `tests/unit/channelIdentity.test.ts`, `tests/unit/A2ADeliveryTracker.test.ts`, and `tests/unit/console-agents.test.ts` cover the observed boundary. The core focused tests passed (2 and 21 tests); the console focused suite passed 19 tests. Full suite and Mac verification remain required before release.
