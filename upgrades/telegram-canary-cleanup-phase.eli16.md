# Let the diagnostic finish cleaning up before judging it

Instar periodically checks its own Telegram configuration readers using a private, disposable fixture. It checks six things, including encrypted configuration, the exact alert destination, an opt-out, a changed destination, changed credentials, and malformed configuration. These checks diagnose the readers. They do not contact Telegram or give any message permission to send.

The old deadline included both the checks and the time needed to close native filesystem watchers. Tracing showed the checks finishing in about a third of a second, while macOS could spend 15 to 43 seconds closing those watchers one by one. That cleanup could make healthy reader checks appear broken. Retrying repeated the same expensive cleanup.

This repair keeps six seconds for the checks and gives their cleanup its own bounded 30-second window. The disposable worker removes its private directory and reports when its work actually finished. Instar then terminates that whole worker thread, which lets the operating system close all of its watchers as one owned boundary instead of serially waiting on each watcher. Instar still waits for the real worker exit and repeats private-directory removal before reporting a pass. While that work is happening, health says cleanup is running. An early success flag cannot establish a passing result.

If cleanup proof is missing, malformed, unsuccessful, or over its deadline, the result stays unavailable and that instance stops trying. Instar retains ownership until the worker really exits and final removal settles. This prevents a second worker from overlapping resources that are still closing. A delayed parent event loop does not turn an already completed worker cleanup into a false timeout.

The existing startup wait, two-attempt ceiling, and completion-relative schedule remain. Every machine checks its own disposable state. Existing agents receive the same explanation as newly installed agents, without replacing their added notes. No stored delivery data needs migration. Rolling back restores the previous diagnostic timing; it does not replay any message.

The acceptance evidence includes malformed and duplicated worker messages, both sides of each deadline, real worker teardown, HTTP health, production boot, and installed-instruction migration. Release readiness still requires the full local suite and normal CI gates.
