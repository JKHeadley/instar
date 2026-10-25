# Feedback Sorting Pause Alarm — Plain-English Overview

> The one-line version: when the feedback sorter pauses itself, the operator is now told once, in plain words, what stopped and how to restart it.

## The problem in one breath

Feedback reports from Instar agents are sorted by a model the operator approved: it decides which reports are ready to become work items. That approval has safety brakes. If the daily spend cap is reached, if a different model or prompt answers, or if three runs in a row produce no usable answer, the approval switches itself off, and only the operator can switch it back on, with their PIN, on the dashboard. That is deliberate: the operator handed this decision to one named model, and an agent re-granting it to itself would be taking a delegation it does not own. The defect is that the switch-off was silent. On 14 October three provider errors in a row paused the sorter, and for four days nobody was told: reports kept arriving, none became work, and the only trace was a status field nobody was looking at.

## What already exists

- **The brakes** — three conditions that switch the sorter's approval off. They stay exactly as they are.
- **The restore path** — the operator's PIN on the dashboard Feedback Drain tab. Unchanged.
- **The attention queue** — the durable list of things the operator should see, posted to the operator's Attention topic. The triage side of the feedback factory already uses it when its own approval breaks; the sorting side never did.
- **A plain-words explanation of each brake** — already shown on the dashboard.

## What this adds

When a brake switches the sorter off, it now raises one attention item: "Feedback sorting is paused", the reason in plain words, a note that reports are still saved but none become work items, and that approving the sorting model again on the dashboard is what restarts it, and that nothing restarts it automatically.

A pause that already happened before this change, or after a restart, or whose first notice failed to send, is caught too: while paused, every scheduled drain run is refused, and that refusal now raises the same item.

## The safeguards

**One item per pause, never a stream.** The item's name is tied to the specific approval that was paused, and the attention queue ignores a second item with the same name. A new approval that later pauses again gets a new item.

**It only tells; it never acts.** It does not restore the approval, retry anything, or change any brake. The PIN gate is untouched.

**It cannot break the drain.** If sending the notice fails, the drain carries on and the next refused run tries again.

**A wrong-model pause is marked high priority**, since it can mean the routing changed underneath the approval; the other two are normal priority.

## What this does not do

It does not decide whether the operator should approve again; that stays their call. It does not change why the sorter paused on 14 October (a Codex command failing several times in a row, which works again now).

## What you need to decide

Nothing. There is no setting. The current pause will be announced by the first drain run after this ships.
