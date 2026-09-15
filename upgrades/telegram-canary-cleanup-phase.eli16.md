# Let the diagnostic finish cleaning up before judging it

Instar periodically checks its own Telegram configuration readers using a private, disposable fixture. It checks six things, including encrypted configuration, the exact alert destination, an opt-out, a changed destination, changed credentials, and malformed configuration. These checks diagnose the readers. They do not contact Telegram or give any message permission to send.

The old deadline included both the checks and the time needed to close native filesystem watchers. Tracing showed the checks finishing in about a third of a second, followed by several seconds closing watchers. That cleanup could exhaust the six-second deadline and make healthy reader checks appear broken. Retrying repeated the same expensive cleanup.

This repair keeps six seconds for the checks and gives their cleanup its own bounded 30-second window. The worker reports the checks first, then reports whether its readers closed. Instar still waits for the worker to exit and for its private directory to be removed before reporting a pass. While that work is happening, health says cleanup is running. An early success flag cannot establish a passing result.

If cleanup fails or exceeds its deadline, the result stays unavailable and that instance stops trying. Instar retains ownership of the outstanding cleanup until it actually settles, even after the deadline. This prevents a second worker from overlapping a worker whose resources are still closing. A deadline does not guarantee that an operating-system cleanup call can be interrupted instantly.

The existing startup wait, two-attempt ceiling, and completion-relative schedule remain. Every machine checks its own disposable state. Existing agents receive the same explanation as newly installed agents, without replacing their added notes. No stored delivery data needs migration. Rolling back restores the previous diagnostic timing; it does not replay any message.

The acceptance evidence includes malformed and duplicated worker messages, both sides of each deadline, real worker teardown, HTTP health, production boot, and installed-instruction migration. Release readiness still requires the full local suite and normal CI gates.
