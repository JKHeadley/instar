# Side effects: a native conversation for every session (part 2 of 3)

Change: New session gains a fourth choice, "Instar app conversation" (`platform: 'app'` on `POST /sessions/create` and the phone's `session-new`). The agent creates an app conversation, seeds its engine and model if picked, records its memory place, and starts a session attached to it. With no Telegram or Slack it is the automatic choice. The session lists stop hiding app-conversation sessions as internal. **Tier 2**: it changes the default for new sessions and adds a spawn callsite. Spec: `docs/specs/session-conversation-for-every-session.md`.

1. **Over-block.**
   - A name that isn't a valid conversation title (1 to 80 characters after cleaning) is refused for `app`, with words. Telegram's 128-character limit still applies to other choices.
   - An app create on a machine whose reply relay isn't ready is refused before anything is created.
   - A machine pick with `app` is refused until part 3.
2. **Under-block.** A standby creates the conversation record, which the phone's own create route already may. It never starts a session.
3. **Level-of-abstraction fit.** Each part reuses existing code:
   - the phone's `applyCreate`;
   - the Telegram seed function, with its disclosure a no-op for app keys;
   - part 1's message-free starter, extended with a reason, a name, and a memory-place step that is the same `onInbound` call an inbound message makes.

   No second create path for conversations.
4. **Signal vs authority.** No new judgment. The memory-privacy verdict decides whether a session may start, as it does for every message.
5. **Interactions.**
   - **Memory privacy.** The place is recorded before the first spawn. Without that, the first message would retire the creation-time session.
   - **Admission.** The new callsite `app-new-session` goes through SpawnAdmission like the other app spawns.
   - **Automatic choice.** It changes only where neither Telegram nor Slack is connected and app conversations run.
   - **Session lists.** A session with a `conversationRef` is never "internal". Before this, every app conversation's session was hidden behind the internal toggle on both the dashboard and the app.
6. **External surfaces.**
   - The create route accepts `platform:'app'` and an optional `requestId`, and answers `conversationKey`, `started` and `refusal`.
   - The dashboard's New session form gains the choice. The phone's signed `session-new` accepts `app`.
   - The phone's Chat line reads "an Instar app conversation".
7. **Multi-machine posture.** The conversation replicates through the app conversation store. The session runs on the serving machine. Part 3 brings per-conversation placement.
8. **Rollback.** Revert. Created conversations remain ordinary app conversations, and the automatic choice falls back to terminal-only again.

## 6b. Operator-surface quality

1. **Primary action first.** The choice sits in the existing platform list, and Automatic picks it where it applies.
2. **No raw internals.** Refusals and results are sentences that say what happens next.
3. **Destructive de-emphasized.** Nothing destructive is added.
4. **Plain at phone width.** One more row in an existing picker.

## Class-Closure Declaration

- **unbounded-self-action — closure: n/a.** This is a one-shot, user-driven action, not a self-triggered loop. Exactly one session starts per person-submitted create, repeats are answered from the first create, and jobs and helpers never take this path.

## Second-pass review

**Reviewer:** independent reviewer subagents over four rounds, the last two reading the implementation. They found:
- 12 design defects, all addressed: memory place, start verification, standby seed and pick, session name reuse, durable repeat protection, and others. See `docs/specs/reports/session-conversation-for-every-session-convergence.md`.
- 12 code issues, all fixed with tests.

**Round 4: concur on design.** Its one code issue, a refused create replayed on retry, is fixed by releasing the request.
