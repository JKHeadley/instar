# Pin conversations to the top of the list — plain overview

## What this is

Justin asked to be able to pin conversations. Now a person can pin a whole conversation so it always sits at
the top of their conversation list, in the iPhone app and in the dashboard's Conversations page. This is
different from pinning a message inside a conversation, which already exists.

## How it works

Each pin belongs to one person. The owner's phones and the owner's dashboard browser all share the same pins,
because they are the same person. A team member or a shared person has their own pins, and can only pin a
conversation they are allowed to see. Each person can pin up to 50 conversations. The newest pin comes first.

Every pin or unpin is saved as a small record that never changes. If two records disagree about the same
conversation, the newer one wins, and every machine picks the same winner. These records are copied to all of
the agent's machines through the same sharing path other per-person settings already use, so a pin made on one
machine shows up on the others. If sharing is not working at the moment a pin is made, the machine keeps a note
and shares it again the next time it starts.

The conversation list sends the pinned conversations along with its first page, including any pinned
conversation that is too old to be on that page, so a pinned conversation always shows at the top.

## What you see

In the dashboard, a "Pinned" group appears at the top of the Conversations list, and every conversation has a
small Pin or Unpin button. If something is refused, such as a 51st pin, a short plain sentence says why.

## Safeguards

- A person can only pin what they can already see; anything else gets the same answer as a conversation that
  does not exist, so nobody can probe for hidden conversations.
- The agent itself cannot pin for nobody; when it acts, it must say which person it acts for.
- There is an off switch, and with it off the list looks exactly as before.

## What you need to decide

Nothing. This is small and fully reversible: turning the switch off or reverting the change removes it, and the
saved pins file can simply be left in place.
