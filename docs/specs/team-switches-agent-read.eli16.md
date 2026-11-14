# The agent can read the team settings summary (ELI16)

A team on an Instar agent needs two settings on every machine: memory privacy and app conversations. The owner's phone shows a short list of any of these that are off somewhere, one line per setting with the machines it is off on, and the owner turns it on with one Face ID tap.

The agent's own instructions told it to answer "is something off that team access needs?" by reading that same list from the phone's route. But the phone's route only answers the owner's paired phone. When the agent asked with its own key, it was refused. So the agent was told to look somewhere it was never allowed to look, and it could not answer the question honestly.

What changes: the agent's own read of who can reach the agent (the people list it is already allowed to read) now also carries the same settings list, built by the very same code the phone uses, so the two can never disagree. It is read-only. The agent still cannot turn anything on; that stays the owner's tap on their phone, with Face ID. The tests check both sides: the agent sees the same list the phone sees, and the agent's key is refused on every route that would turn a setting on.

The agent's instructions now point at the readable place. New agents get the new wording when they are set up, and existing agents get that one phrase rewritten when they update. The rewrite only touches the team settings line, and running it again changes nothing.

If this turns out wrong, undoing it is a plain code revert. Nothing is stored, nothing is sent to anyone, and no machine behaves differently except that the agent can now answer the question it was always told to answer.
