# The PIN on the Mama PC's secure link — in plain words

**The problem.** The Mama PC runs Instar inside a Linux layer on Windows. When the operator opens its dashboard through the secure link, Windows receives the encrypted connection and hands the request to Instar over an ordinary internal connection. Instar only accepts the PIN on an encrypted connection or one from the machine itself. It saw neither: the request came from the Windows side's internal address. So the operator typed the PIN and got an error, even though the link was secure the whole way to the machine.

**What changes.** The Windows side marks each request it hands over: "this arrived over https". Instar now trusts that mark, but only when it runs inside that Linux layer and the request comes from its own Windows side. Everywhere else nothing changes. A plain, unencrypted request through the same route is still refused.

**Safeguards.** Someone could fake the mark from the local network, but that would only let them type their own PIN unencrypted, which they would still need to know. The operator's PIN stays off the network as before. The remote-desktop checks are untouched.

**What to decide.** Nothing beyond review. Reverting the change undoes it.

**Follow-up.** The safe fallback in the WSL check now carries an explanatory note, as a project rule requires. Behaviour is unchanged.
