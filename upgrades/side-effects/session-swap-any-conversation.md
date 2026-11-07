# Side effects: engine and model changes for every conversation (part 1 of 3)

Change: an app or Slack conversation can switch its engine and model from the dashboard and the owner's phone, as a Telegram topic already could. App and Slack spawns now start on their conversation's profile. A switch restarts the session with the conversation kept. **Tier 2**: a device allowlist pattern widened, the profile write surface's token authority extended, and the profile orchestrator's ports made per-kind. Spec: `docs/specs/session-swap-any-conversation.md`, converged in 6 rounds and approved under the standing grant.

**Second-pass reviewer:** independent reviewer subagent (below).

1. **Over-block.** A token write to an app conversation is refused on a standby machine ("Another of your machines runs this conversation right now"), and for a support person's conversation. A Slack write is refused on a machine without the Slack connection. Each refusal says what to do. Moving app and Slack conversations between machines is still refused, said plainly, until part 3.
2. **Under-block.** The owner's dashboard token and Face ID phone can switch any app or Slack conversation this machine serves. Telegram keeps its bound-operator rule exactly: the new hook is never consulted for a numeric topic, and a chat-command principal on an app key is still refused.
3. **Level-of-abstraction fit.** There is one mapping from reference to profile key (`conversationKeys`), one authority rule (`tokenMayWriteConversation`), and one set of per-kind ports (`_conversationPorts`) used by the write surface, its disclosure, and the orchestrator. The Slack guards sit at the adapter's single save, so the kill hook, heartbeat and shutdown writers all get them without three copies.
4. **Signal vs authority.** No new judgment. The write gate the Slack writers consult is the orchestrator's existing gate, made engine-aware (`resumeWriteGateFor`).
5. **Interactions.**
   - An unset profile resolves to the agent default, so an app or Slack spawn launches as before.
   - A Slack record written before this change has no engine. It is resumed only on the agent default, and is never "ready" for a hook-verified resume.
   - An app message that arrives mid-switch waits up to 60 s for the restart instead of starting a second session.
   - The new spawn callsite `app-respawn` goes through SpawnAdmission like `app-inbound-spawn`.
6. **External surfaces.**
   - The phone's door route accepts `telegram:N`, `app:<key>` and `slack:<team>:<channel>[:<thread>]`; a bare topic id still works.
   - `GET /sessions` rows gain `conversationRef`.
   - `/topic-profile/:key` accepts `app:<key>`.
   - The dashboard offers the engine switch for app and Slack sessions.
   - Disclosure lines appear in the conversation itself: an agent message in the app, or a post in the Slack channel or thread.
7. **Multi-machine posture.** App conversations are served by the lease holder. A switch runs only there; anywhere else it is refused with words. Profiles already replicate per key. Part 3 brings app conversations into the session pool.
8. **Rollback.** Revert. Profiles written under `app:` keys stay on disk, are ignored again, and spawns fall back to the agent default. Slack records keep their extra fields, which older code ignores.

## 6b. Operator-surface quality

1. **Primary action first.** The engine switch is the same button and sheet as for Telegram, now shown for app and Slack sessions.
2. **No raw internals.** References stay inside requests. People read "an Instar app conversation", and refusals in words.
3. **Destructive de-emphasized.** A switch restarts the session and keeps the conversation, behind Face ID on the phone, as before.
4. **Plain at phone width.** No new layout. The move row shows one sentence when moving isn't available yet.

## Second-pass review

**Reviewer:** an independent reviewer subagent, one round. It found four concerns, all fixed, with tests:

1. **Defect: a Slack conversation lost resume after one switch.** A parked Slack record blocked every later save, and only a failed kill or a revert unparked it, so after a successful switch the conversation never resumed again.
   - A save the write gate allows now replaces a parked record, as Telegram's resume map does.
   - A parked record older than a day is dropped.
   - The spec's wording is corrected to match.
2. **Race: two app sessions for one conversation.** A message already spawning when a switch started could produce two sessions.
   - The inbound spawn and the message-free start now share a per-conversation lock, and each re-checks for a live session inside it.
   - A message that waited is injected into the session that started.
3. **Topic 1 (Telegram's General topic) was newly offered a switch on the phone.** It no longer is, as before.
4. **The legacy restart could throw on a resolver fault.** It now fails softly with words.

**Otherwise concur:** the authority checks, the allowlist and refusal of `%`, Telegram paths unchanged, the spawn option names, and no double-recording. It also noted a parity gap: app spawns passed engine and model but not the thinking-mode and effort pins that Slack and Telegram spawns pass. That's now closed: both the inbound spawn and the message-free restart carry them, with tests.

## Class-Closure Declaration

- **unbounded-self-action — closure: n/a.** This is a one-shot, user-driven action, not a self-triggered loop. An app or Slack session restarts only after the operator's own engine write. That restart goes through the profile orchestrator's existing debounce, its concurrency cap of 2, and its spawn-failure breaker. The app and Slack spawns still run once per inbound message, as before; they only now carry the conversation's engine.
