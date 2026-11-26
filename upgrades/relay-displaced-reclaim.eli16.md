# A machine bumped off the agent relay takes it back (ELI16)

Agents talk to each other through a shared relay, and the relay allows one connection per agent identity. When a second connection with the same identity arrives, the first one is kicked off ("displaced").

Before this change, a displaced connection gave up for good, and its health report still said it would recover. That is what happened to Luna: her Studio briefly connected with her identity, her laptop was kicked off, and for 40 hours no agent could reach her, with nothing raising an alarm.

Now:
- The health report says "displaced" honestly instead of "will recover".
- The server raises a degradation alert, so the problem shows up.
- After a 15-minute pause, the machine takes its connection back. Only the machine that is supposed to own the relay ever holds a connection (a standby never connects), so taking it back is the right outcome. The pause keeps two misconfigured machines from fighting over it every few seconds.
- Two other ways a connection could stall forever are closed: a rejected login that left the socket hanging, and a failed first connection that the server stopped tracking.
- Agents learn, through their instructions, to check their own relay before assuming a quiet peer is ignoring them.
