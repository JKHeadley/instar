# The second place that forgot to ask "is this topic live?"

> The one-line version: the same live-session flag that was broken in the cross-topic view is also unwired in the work queue, so a conversation with a session running on it could never be ranked above a dormant one — and now a test refuses to let any future place forget.

## The problem in one breath

The helper that answers "does this topic have a live session?" is an optional argument. When it is not supplied, the answer defaults to "no" for everything. No error, no warning — an omitted argument and a genuinely quiet system produce the same output.

It was omitted in the work queue's copy. That queue scores each conversation's urgency, and a live one is meant to score seventy against a dormant one's forty. Because the answer was always "no", every conversation scored forty. The higher score was unreachable.

This is the second instance of the same root cause in an hour. The first was the cross-topic view, where the helper WAS supplied but looked for a field that does not exist. Same silent default, two different ways of arriving at it.

## What already exists

- **A correct helper**, added when the first instance was fixed: it resolves a conversation from the terminal session name through the messaging registry, with tests covering it.
- **A work queue** that gathers pending items from several sources — commitments, improvement actions, feedback, and conversations — and scores each for urgency.
- **A view** whose live column now works, after the first fix.

## What this adds

**The work queue's copy is wired to the same helper**, so a conversation with a live session can now actually reach the higher urgency.

**And a test that reads the source and fails if any construction of that helper's owner omits the argument.** This is the part meant to outlast the change. Two places forgot within an hour; a third would have been silent in exactly the same way. The test names the offending file, so the next person sees what to fix rather than a bare failure.

## Why a source-reading test, unusually

Normally a test should exercise behaviour, not inspect text. Here the defect *is* a missing argument, and the failure it causes is invisible from the outside: the wrong answer and the right answer are the same value. Behaviour tests could not see it — the existing ones pass a stand-in for the very thing that was missing, which is precisely why they never noticed.

So the check is deliberately structural, and it carries its own controls: one proving it finds construction sites at all, one proving it can detect a missing argument, and one proving its scanner survives nested brackets and inline functions. Without those, a check that silently matched nothing would pass forever and prove nothing — the same failure it exists to prevent.

## The safeguards

**Nothing changes about how urgency is used.** The scores and their meaning are untouched; only the input becomes truthful.

**Failure stays safe, and the fallback is declared rather than hidden.** If the lookup throws, the answer falls back to "not running" and the queue keeps working — a ranking hint must never be able to break the queue it ranks.

The project keeps a running count of places that swallow an error quietly, and refuses to let that count grow. This change tripped it, which was the count doing its job. Rather than raise the allowance, the fallback carries an explicit marker and a written reason: "not running" is the same answer the missing argument produced anyway, and reporting a degradation here would fire on every pass for any session that is not a chat conversation. The declaration is the point — a silent fallback that is written down stops being silent.
