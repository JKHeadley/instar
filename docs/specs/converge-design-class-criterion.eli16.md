# A review loop that could never finish

## What this is about

Before instar's own code can be changed, the design has to pass a review loop. Several reviewers read
the spec from different angles — security, scalability, adversarial, integration — the author fixes
what they raise, and the loop runs again. It stops when a round comes back clean, and there is a hard
cap of ten rounds.

Two specs in a row hit that cap. The naive reading is that the designs were confused. They were not.

## Why it could not finish

The loop stopped when a round produced no "material" findings, where material meant *anything that
would require a change to the spec if left unaddressed*.

That sounds reasonable until you notice what the spec is. Each round appends its own review history to
the document, so the document gets longer every time. And a careful reviewer reading a longer document
will always find some wording to sharpen, some contract to state more precisely, some scope boundary
to name. Every one of those requires a change to the spec — so every one counted as material.

The result: the loop could not terminate, no matter how sound the design was.

The evidence is unusually clean. One spec recorded four or five findings under a column headed
"Material findings" in every single one of its ten rounds — while the report written alongside it
noted that rounds five through ten produced no design defects at all, only precision.

So the cap fired for a reason that had nothing to do with whether the design was good. The stop
signal was measuring document length.

## What changed

Findings are now sorted into two kinds, and each reviewer states which kind it is raising rather than
leaving it to be guessed later:

- **Design-class** — it changes what would actually be built or how it would behave. Architecture, a
  safety or security property, a decision point, a missing failure mode. Also, importantly, any
  statement in the spec that is simply *wrong* about the system.
- **Precision-class** — it improves the document without changing what would be built. Wording,
  naming, a clarifying example, a scope boundary spelled out.

The loop now stops after two consecutive rounds with no design-class findings. Precision findings are
still raised and still fixed — they are genuinely useful, and several of them changed real code — but
they no longer keep the loop running forever.

Two rounds rather than one, because a single quiet round is weak evidence on a document whose surface
keeps growing.

## The honest limitation

This does not remove judgement, it relocates it. Someone still has to decide whether a finding is
design or precision, and a reviewer that wrongly files a real design defect as "just wording" could
end the loop too early.

Two things reduce that risk. The rule names the dangerous case explicitly: a claim that is factually
wrong about the system is design-class, never precision — that exact case was caught in round ten of
one spec. And the report must now record both counts per round, so a suspiciously quiet round is
visible to whoever reads it rather than quietly accepted.
