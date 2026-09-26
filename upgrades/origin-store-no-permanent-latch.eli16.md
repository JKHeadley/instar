# One slow moment must never permanently silence the agent (plain-English version)

Before an agent sends any Telegram message, Instar writes down what it is about to send. That record lets it prove later who sent what, and it keeps a message from being sent twice or lost. The writing is done by a small background helper, called a worker, that owns the database on disk.

On 2026-09-26 the Mac Studio rebooted. The agent's server started while the computer was still busy catching up on disk work. One request to the worker took longer than 2 seconds. The old code treated that single slow request as proof the worker was broken, so it shut the worker down. Nothing ever started it again. From then on every Telegram message from every topic was held, including the notices a session sends when it restarts. The agent could not be reached until someone restarted the server by hand. That breaks a core rule: the agent is always reachable.

This change fixes that in three ways.

First, a slow request now only affects itself. The one caller that waited too long gets a "held, outcome unknown" answer, and the worker keeps running. The next request is served normally once the disk catches up. The worker is only treated as stuck if it answers nothing at all for 30 seconds while work is waiting. Time spent waiting in line behind work that is moving does not count.

Second, a stuck or crashed worker is replaced automatically. The first retry comes after 1 second and each wait doubles, up to 30 seconds, with at most 6 tries in a row. The count only resets after the new worker has run for 5 minutes without failing, so a problem that keeps coming back still hits the limit. If all 6 tries fail, the worker stays down, and the existing recovery check tries a fresh one every 15 minutes. That fresh one carries over the used-up count, so a lasting outage never gets a new burst of retries. If the server starts while the worker cannot start, the same automatic retries apply, which covers exactly what happened after the reboot.

Third, it is loud. An outage creates one degradation report, not one per retry. The authenticated health check now shows the worker's state: ready, starting, restarting, exhausted or closed. It also shows how many restarts have happened, the last failure and since when it has been down.

What does not change: while the worker is down, messages are still held and nothing is sent unrecorded. A message whose write may or may not have finished is never blindly sent again. It goes through the same recovery path as before, keyed to its original identity.

Nothing needs deciding.
