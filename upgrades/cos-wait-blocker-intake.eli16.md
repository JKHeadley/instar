# Record project waits for the Chief of Staff to investigate

When the Chief of Staff checks a project, the check can record that progress has paused. A trial feature can copy that observation into the existing blocker ledger with a reference to the original project check. This gives the Chief of Staff a place to investigate what happened. It keeps repeated reports of the same wait together, including after a restart. A check based on an older checklist cannot create an entry for the current checklist.

The trial is off by default. It does not add an approval request, change how you finish a project, or change which rows you see in Needs-you. Before enabling it on a real agent, the project still needs the checks that confirm a wait remains current during a handoff between machines. Those checks will also make sure a retired wait cannot later become an approval request.

The trial also checks the source again before changing a blocker. If the project has a new checklist, the old blocker stays as history and the server refuses to advance it. A fresh project check can open a new blocker if the wait is still real.
