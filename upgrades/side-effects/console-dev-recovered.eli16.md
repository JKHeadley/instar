# The recovered dashboard — in plain words

**What happened.** For several days the operator reviewed a new version of the dashboard on his phone and asked for changes, and I made them. All of that lived in an unsaved working copy on one machine, served by a small preview program. When that machine restarted, the program stopped, and the work was one cleanup away from being lost. It is now saved, merged with everything that shipped since, and ready to ship properly.

**What he gets.** The front page shows only something he can act on, as a link straight to it. Otherwise it says "Nothing needs you". Things the agent handles itself (its own promises, machines, safety settings) are folded under "See agent status" instead of shouting from the top. The same request never appears twice: a pull request waiting for his approval no longer also shows as a separate promise to merge it. Each promise explains how it came about and offers a one-tap question to ask for an update. Overdue ones show their due date.

**A real reliability fix.** Some promises had been recorded in a form that could never be checked, for example "change a setting" without saying which one. Every check counted that as another failure, and one promise piled up over 23,000 of them, which made the checks look broken. New promises in that form are now refused with a clear reason. Old ones stop collecting false failures, but are never marked as done either.

**What to decide.** Nothing beyond review. He has already seen and shaped these screens. Reverting the change undoes it.
