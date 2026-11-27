# The trust journey change after its rebase, in plain words

## What happened

This change (stage 0, part C of the trust journey) waited a day without an owner while other work merged. The easy-setup work adopted it, because approving trust raises from the Instar app builds on top of it. It has now been moved onto the current main line of code.

## What changed in the move

The first part had already merged on its own, so it was left out. The other two parts met newer code in the server start-up and in one list of imports. In both places the old and the new lines were kept together, nothing was dropped.

## The small fixes

A safety test counts places where code quietly swallows an error. It found three new ones. Two were already fine: one tells the person that their approval was recorded but the change did not take effect, and one falls back to a file it reads right after. Those now carry the standard note that explains why. The third really was silent: when a reply in Telegram could not be read as an approval, nothing was written down. It now writes a line to the log first, and as before, a reply that cannot be read approves nothing.

All 105 trust journey tests and the 16 safety tests pass.

A second safety test checks that every route which changes saved state says how that state is shared between an agent's machines. The two new routes for the trust journey's approval requests now say so: their records are copied to all of the agent's machines.

An independent reviewer read the whole change and agreed with it. They noticed one place where the agent could see the approval code meant only for the person's card. Seeing it granted nothing, but that place now hides the code too.

The reviewer checked that fix as well and agreed with it.
