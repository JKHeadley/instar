# Plain overview: no more held notices right after a restart

When the Mama PC restarts, it takes about 12 seconds before it learns that it should
pass its messages to the Studio (the machine in charge of Telegram). Any automatic
notice it tried to send in those seconds went the old way, was refused because the
Mama PC is not in charge, and sat "held" for 6 hours until it expired. The earlier
fix (PR 2524) covered the case where the machine knew its routing rule but not who
was in charge; this covers the seconds before the rule exists at all.

Now, on a machine that has a partner machine, a message sent in those first seconds
waits until the routing is ready (at most 30 seconds) and then goes through the
normal path to the Studio. A machine on its own never waits. Nothing is refused or
dropped; the only effect is that a notice right after a restart can arrive a few
seconds later.
