# Record project waits for the Chief of Staff to investigate

When the Chief of Staff checks a project, the check can record that progress has paused. A trial feature can copy that observation into the existing blocker ledger with a reference to the original project check. This gives the Chief of Staff a place to investigate what happened. It keeps repeated reports of the same wait together, including after a restart. A check based on an older checklist cannot create an entry for the current checklist.

The trial is off by default. It does not add an approval request, change how you finish a project, or change which rows you see in Needs-you. Before enabling it on a real agent, the project still needs the checks that confirm a wait remains current during a handoff between machines. Those checks will also make sure a retired wait cannot later become an approval request.

The trial also checks the source again before changing a blocker. If the project has a new checklist, the old blocker stays as history and the server refuses to advance it. A fresh project check can open a new blocker if the wait is still real.

When the trial is first enabled, the Chief of Staff checks older waits again before adding them to the ledger. A note copied from an older check cannot open a blocker on its own.

After a machine takes over, an apparently complete local copy can still be missing a checklist change. The trial requires verified journal evidence before it can advance a recorded wait. The production trial remains off while the machines gain a way to supply that evidence.

The trial also checks that the snapshot came from the machine and journal generation currently allowed to make the decision. During a handover or an outage it waits. The new check is covered in a test setup, with live activation still off.
