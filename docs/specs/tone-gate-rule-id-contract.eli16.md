# The tone gate was teaching models to fail its own test — plain-English overview

Every message an instar agent sends to its user first passes through a quality
gate: a language model reads the draft and answers, in a small JSON verdict,
"is this message OK to send, and if not, which rule does it break?" The gate's
code then reads that verdict. Here's the bug this change fixes: the code that
READS the verdict insists on the full rule name — something like
`B15_CONTEXT_DEATH_STOP` — and treats anything else as unreadable, on purpose
(unreadable verdicts are treated cautiously rather than waved through). But
the instructions we hand the model literally listed the SHORT names — "rule
MUST be exactly one of B1–B9, B11, … B15, B16…" — so models did exactly what
we asked, answered "B15", and the reader rejected it. We told them to say the
thing we refuse to read. Our own benchmark caught this: on some test cases
literally every model, through every access route, "failed" the same way —
which is never a model problem, it's a prompt problem.

What ships here is two small text corrections inside those instructions.
First, the instructions now say: give the FULL rule name, exactly as written
in the rule list, never the bare number. Second, a new line tells the model
how to safely quote the message it's judging: if the draft being judged
contains quotation marks, the model must not copy them raw into its JSON
answer (raw quotes inside JSON break it — like closing a sentence's quotation
mark mid-sentence), and should use single quotes instead. That second fix
came out of the testing too: we watched a model give a perfectly correct
verdict that was unreadable purely because it quoted the draft with raw
quotes.

Nothing about WHAT the gate blocks or allows changes — the rules, their
meanings, and the gate's authority are untouched. The change was proven with
an A/B test before shipping: the old and new instructions ran side by side on
the same 118 test cells across seven different model routes; the new text
fixed 40 previously-failing cells and broke zero previously-passing ones. A
small automated test now pins both corrections in place so a future edit
can't quietly reintroduce the mismatch. If anything ever looked wrong in
production, the rollback is reverting two sentences of instruction text.

What you need to decide: nothing — this is a repair of a self-contradiction,
pre-approved under the benchmark program's ratified ship policy (critical
components ship with a review record attached, which this one carries).
