# Side effects: pair-handover-allowlist

**Summary.** Tier 2 by risk (who may reach the agent), small: 6 source files, about 60 lines. One review pass on an amendment to an already converged spec, and one independent second pass.

**Change.** The sealed Telegram handover at pairing now carries `authorizedUserIds` and `ownerUserId`. The joiner writes them, and writes the reply script to both script folders before first boot.

**Why.** Fresh-pair test, 2026-11-05: a machine joined on 1.3.1676 had the bot token and neither field, and no `telegram-reply.sh`. `TelegramAdapter.isAuthorized` returns true for everyone when the list is empty, so that machine would accept any member of the chat once it polled. The behaviour is in releases since v1.3.1669.

**1. Over-block.** A hand-edited list holding an entry that is not an id, such as `[123, "abc"]`, still works on the first machine but now fails the handover as `malformed`: the second machine gets no Telegram entry and says so. This fails closed. Fixing the list and pairing again recovers it. An owner written as `null` counts as unset, as the adapter treats it.

**2. Under-block.** A person added to the list later, on the first machine, does not reach the second. A machine already joined stays open until it is paired again, and that recovery only works on a two-machine pool: with a third machine, a re-pair gets no handover, so the list has to be set by hand. A joined machine whose re-pair could not open the handover keeps its entry and says so. Filling a list requests a restart, because a running server keeps its old list. The fault first shipped in v1.3.1669, built the night of 2026-11-04, so only a pairing made since then is affected.

**3. Level of abstraction.** The handover is the only moment a joined machine gets Telegram, so this is the layer. The adapter's "no list means everyone" default is unchanged, because single-machine agents depend on it.

**4. Signal vs authority.** No new authority. It feeds the existing adapter check the data it was missing. Refusing a malformed list is a structural parse, not a judgment.

**Second pass (independent reviewer).** Concern raised, then resolved in this change: a failed re-pair was silent and a filled list needed a restart (now both handled); an owner in `promptGate.ownerId` was not carried (now carried); `ownerUserId: null` failed the handover (now unset); a reply-script failure printed the wrong message (now its own message). The third-machine limit stays and is named above. A second round raised two more, an own `promptGate.ownerId` being overridden and a failed restart request printing the wrong message; both fixed. Final round: concur.

**5. Interactions.** `decidePairActivation` already resends the handover on a re-pair. The joiner now opens it in that case too, and ignores a failed open when it already has a Telegram entry, so the old `kept-existing` result is unchanged. `migrateScripts` manages the same two script paths on update, and its install-if-missing and SHA-migrate checks treat this copy like any other install.

**6. External surfaces.** One more field inside an encrypted payload. An older joiner ignores the extra fields. An older inviter sends none, which is today's behaviour.

**7. Multi-machine posture.** Copied once at pairing, not replicated afterwards. A later change to the list stays on the machine where it was made; that existed before this change and is filed as feedback.

**8. Rollback.** Revert the commit. Lists already written stay in the joined machine's config and keep working. No migration.
