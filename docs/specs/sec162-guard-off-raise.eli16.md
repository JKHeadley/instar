# ELI16: switching off a safety guard now needs the owner (SEC-162)

Your agent has safety guards, small watchers that stop sessions from getting stuck, check what goes in and out, and catch runaway behavior. Until now, anything holding the agent's key could switch one of those guards off through its settings interface, without asking anyone. Other risky changes, like giving the agent more freedom with outside services, already needed the owner's approval, but switching a guard off did not.

Now switching a guard off is treated the same way. The change is not made, and the owner gets the usual approval card on their phone, naming the guard. If they approve, it is switched off. Switching a guard back on, or adjusting one that stays on, still needs nobody. One everyday switch is affected: turning off the input guard or the response review from the feature list now asks the owner first.
