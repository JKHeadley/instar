# Convergence Report — an ack is never acked

## Cross-model review: codex-cli:gpt-6-astra (RAN — both passes)

One review round, as scoped for a bug fix, plus one confirming re-read after the
fixes. Each pass ran:

- the Standards-Conformance Gate (92 standards);
- an external GPT-tier review through the agent's codex CLI (`gpt-6-astra`).

No internal multi-angle reviewers were run. The author session was
`claude-opus-5-5`.

## ELI10 Overview

When one agent sends another a message, the other one automatically answers
"Message received." That note looked like a normal message, so the first agent
answered it with its own "Message received", and so on, about five times each
way, until a safety limit stopped it. Worse, when we had started the
conversation, the note counted as "someone new is talking to us" and a whole
working session was started to answer it.

The fix: the note now carries a label that says "this is only a receipt". An
agent that gets a labelled receipt writes down that its message arrived and
does nothing else. Receipts from older agents, which have no label, are
recognised only when the message is exactly the one fixed sentence. Separately,
the check that decides whether a message deserves an answer now treats a bare
"thanks" as not needing one, even when it is the first message in a
conversation.

## Original vs Converged

- **Recognising an older peer's ack.**
  - Original: any message opening with `Message received.` that was short and
    had no question mark.
  - Converged: the whole message must be exactly the fixed sentence. The old
    prefix test keeps only its earlier job (not handing such a message to a
    reply waiter).
  - Why: the Standards-Conformance Gate flagged the prefix version under
    *Signal vs. Authority*: `Message received. Deploy the fix now.` would have
    been set aside by a text matcher. An intermediate version (prefix plus the
    gate's acknowledgement vocabulary) was flagged again and dropped.
- **The invariant's scope.** The external review pointed out that "an ack is
  never acked" could not be promised for acknowledgements the stage does not
  recognise. The invariant now says it covers recognised automatic acks; other
  acknowledgements get the warrants gate's normal decision.
- **Reply waiters.** Clarified that a recognised ack never resolves a waiter
  (already true in the code; the spec's wording left it open).
- **Compatibility claim.** Bounded to the code that could be read: `main` at
  890f02396. Older releases are stated as unverified.
- **Delivery matching, HTTP field mapping, audit.** The confirming re-read
  asked how a receipt is matched to a sent message (by thread, oldest first —
  now stated and tested), what the HTTP routes read (now stated and tested on
  both routes), and how the live criterion can be checked without stored text
  (the log line now names `by type` or `by exact-text`).

## Iteration Summary

| Pass | Standards gate | External review | Changes |
|---|---|---|---|
| 1 | 2 possible violations (legacy text recogniser; pure-ack ahead of first contact) | MINOR ISSUES — 3 findings | Exact-sentence recognition; invariant scoped; waiter wording; compatibility bounded |
| 2 (re-read) | 2 possible violations, both on the pure-ack reorder only | MINOR ISSUES — 3 new, all clarifications | Delivery matching stated; HTTP mapping stated; recognition reason logged; tests added |

## Open item carried to the operator's review

The Standards-Conformance Gate still reports **two possible violations**
(*Intelligence Infers, Keywords Only Guard* and *Signal vs. Authority*), both
about one thing: moving the warrants gate's existing pure-ack check ahead of
first contact lets a fixed word list decide that a hand-written "thanks" needs
no reply before the classifier is asked.

This was not changed, for three reasons the spec states in Design §3:

1. The reorder is the instruction this fix was given, and the pure-ack check is
   the gate's existing deterministic signal — it already runs ahead of novelty
   and the classifier for every message after the first. The change removes one
   exemption; it adds no new matcher.
2. The message itself is kept: it is recorded on the conversation, and on the
   relay path it is in the canonical inbox before the gate runs.
3. A question, an instruction, the sender's `expectsReply` or a verified human
   in the thread all decide earlier and always get a reply.

A related consequence, found when the built code was reviewed and now stated
in the spec: a suppressed first reply is not shown in a Telegram topic the
thread was started from. With a peer that auto-acks over the relay this
matches today's behaviour, because the peer's real reply used to be the second
message. It is new for same-machine agents and for peers with `autoAck` off,
where a first reply of only `lgtm` or `will do` used to be shown. The same
code review moved the `/messages/relay-agent` ack stage ahead of the message
store and named listener-daemon mode as not covered.

The gate's finding is advisory. It is recorded here, unresolved, so the
reviewer sees it rather than discovering it. If the pure-ack word list should
stop deciding alone anywhere in the gate, that is a change to the gate as a
whole (the same reading applies to its behaviour before this fix) and would be
its own item.

## Convergence verdict

Converged for a bug fix at two passes: the remaining external findings were
clarifications that no longer changed the build, and the one standing
standards-gate flag is disclosed above.
