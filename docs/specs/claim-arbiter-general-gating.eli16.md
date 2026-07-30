# Stop paying for an answer we throw away — ELI16 overview

## The one-sentence version

A background check has been asking the AI model for two answers on every call, then deleting
the second one unread on roughly four out of five calls — and producing that deleted answer is
what makes the call run out of time, which destroys the first answer too.

## What this check is

Instar has a quiet background check called the **completion-claim verifier**. When an agent
writes a message like *"Merged the fix, and I'll report back when CI is green,"* the verifier
asks a small language model to label each clause: is that a **promise about the future**, a
**claim that something is already done**, or **neither**? That labelling is what lets the rest
of the system notice when an agent says it did something it did not do.

That is the part that gets used. Call it the **legacy** answer.

Some time later, a second, much bigger request was added to the *same* call. It asks the model
to extract up to four factual claims and describe each one across roughly twenty fields —
categories, byte offsets into the message, confidence scores, and so on. Call it the
**general** answer. It is a newer, still-experimental feature.

## The bug

The general answer is deliberately only accepted when the call runs on Claude. That was a
sensible design decision, and the code that enforces it is correct.

The problem is that **the request was never told about that rule.** So on an installation whose
internal checks are routed to a non-Claude model — which is now the shipped default — the model
is still asked for the general answer, spends real time and money producing it, and the code
discards 100% of it on arrival.

That alone would just be waste. What makes it a real fault is the knock-on effect. The call has
a sixty-second limit. Producing the big answer is slow enough that the whole call regularly
blows through that limit and gets killed — **taking the small, useful answer down with it.**

On the affected installation that showed up as this check failing on about **83% of 1,207 calls
in 24 hours**, while consuming roughly 2.4 million input tokens and producing nothing usable.

## The measurement

Rather than reason about it, both versions of the request were timed head to head — same model,
same door, same message, alternating between the two so that a slow patch would not land
unfairly on one of them.

| Request | Median time | Output size | Fit inside the 60s limit? |
|---|---|---|---|
| With the general answer | 129.2 seconds | ~8,300 tokens | **No** — 0 of 3 runs |
| Legacy answer only | 28.2 seconds | ~1,400 tokens | **Yes** — 3 of 3 runs |

That is **4.6× the time and 6× the output** for a result that is thrown away. The two sets of
timings do not overlap at all. The legacy-only reply was separately checked and is valid,
correct output — it labelled an instruction to the reader as "neither" and flagged an
unsupported claim as uncorroborated — so this is a pure cost saving, not a capability trade.

## What changes

Before building the request, the code now asks the router a question it could always answer:
*which model will this call actually go to?* If the answer is Claude, nothing changes at all —
the full request goes out exactly as before. If the answer is anything else, the general half of
the request is left out, because it could not have been accepted anyway.

The two request shapes are recorded under **different names**, so that later analysis of "how
good is this check?" never silently blends a fast small request with a slow large one.

## The safeguards, in plain terms

The one thing that could go wrong is suppressing the general answer on an installation where it
*would* have been used. Every path is deliberately biased against that:

- If the router cannot be asked, the full request goes out.
- If the router answers with nothing useful, the full request goes out.
- If the router throws an error, the full request goes out.
- If nobody wires the new option up at all, the full request goes out.

In other words, the old behaviour is the default and the fallback. Only a clear, positive answer
of "this is going somewhere that is not Claude" changes anything.

## How confident should you be

The cost measurement is solid: controlled, alternated, non-overlapping.

Two honest limits. Three samples per side is a small number — it is carried by the size of the
gap, not by the sample count. And while the change is *expected* to drop that 83% failure rate,
that remains a **prediction until the change ships and the real number moves.** It is not being
counted as proven.

## What you actually need to decide

Nothing, unless you disagree with the trade. The change removes a request whose answer is
discarded on the affected path, keeps the answer that is used, and leaves Claude-routed
installations byte-for-byte identical.
