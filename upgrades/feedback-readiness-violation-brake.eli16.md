# ELI16 — one odd answer no longer switches the feedback sorter off

## The problem

The feedback sorter ("drain") asks a model which groups of bug reports are ready to become a
task. The operator approves that model once, with a PIN. Some problems switch the approval off
("demote" it), and after that only a new PIN approval turns it back on.

On 2026-10-02 at 02:30 the model answered a normal question about 10 groups. Two of those
groups were near-copies of each other. For each one, the model pointed at the other group's
evidence instead of its own. The checker treated that as "this is not the model you
approved" and switched the approval off. Every run after that was refused. Nothing recorded
which check had failed or what the model had said.

We asked the same model the same question three more times. It did the same thing twice.

## The fix

The safety checks now sort problems into two kinds.

- **"This is not the approved decider."** Examples: a different model answered, the prompt
  or the answer format no longer matches the approval, a batch is bigger than approved, or
  the daily spending cap is hit. These still switch the approval off at once, as before.
- **"The approved model gave a bad answer."** Examples: the answer is not valid JSON, it
  answers about the wrong groups, or it has an out-of-range score. Nothing from that answer
  is used. Its groups are asked about again in 15 minutes. This counts like a timeout: only
  three runs in a row with no usable answer switch the approval off.

When one group points at evidence that is not its own, only that group is held back. It can
never be marked ready that way. The other groups in the answer still count.

Every failed question now leaves a record: which check failed, a short cleaned-up piece of
what the model said, which groups were asked about, and the model's name. The status page
shows the latest record. It also says in plain words why the approval is off, when it is off.

## What does not change

The question wording, the answer format, the approved model, the batch limit and the spending
cap all stay the same, so the current approval stays valid. The approval that was switched
off at 02:30 has already been replaced: version 5 was approved after the incident. When this
lands, no new approval is needed.
