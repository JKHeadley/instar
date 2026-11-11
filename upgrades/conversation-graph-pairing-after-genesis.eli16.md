# Conversations: pairing a new machine no longer breaks the others

Conversations is still off by default. When it runs on several machines, those machines hold a signed list of who belongs to the group. Pairing a new machine is a separate thing: it means the machines trust each other to talk, not that the new one belongs to the group.

The code mixed those two up. If you paired a new machine after the group had formed, the existing machines saw a list that did not match and fell back to working on their own, showing "Working locally. The agreed view is unavailable." Nothing was lost, but shared conversations stopped working and nothing explained why.

Now the machines in the group check that every signed member is still there, and they ignore extra paired machines. They keep working, keep saving, and do not wait for the new machine. The new machine cannot read anything, because stored data is encrypted only to signed members.

A new machine cannot join the group yet. That part is not built, so it holds no Conversations history for now. Whether to deploy before or after joining is built is a decision waiting on the owner.
