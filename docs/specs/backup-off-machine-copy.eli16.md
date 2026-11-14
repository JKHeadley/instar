# A copy of the agent off its machine, in plain English

Your agent keeps snapshots of itself, but on the same computer. If that computer dies, the snapshots die with it. Today the fix is GitHub for memory and Bitwarden for passwords and keys, and both are outside services. The goal is that no agent depends on them.

This plan is for a copy that lives somewhere else without needing any outside account. That might be another computer you own, another agent, or a drive. If you say no to GitHub and Bitwarden, your agent could still come back after losing its machine.

Nothing is built yet. This is a placeholder that keeps the work on the list, with Echo as its owner.

The plan still has to decide:

- where the copy goes, and what someone with only one computer gets
- how it's encrypted, and how you get the key back when the machine holding it is gone
- what goes in the copy, since passwords need more care than memory
- how the agent proves a copy can really be restored, not just that it was saved

It's finished when an agent is restored onto a clean machine from this copy, and the catalog stops listing these as gaps.
