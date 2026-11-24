# An isolated experiment for the conversation working indicator

This checkpoint saves the code and tests for a local experiment. It watches the information that a disposable Codex session already sends between its terminal and its server. The experiment showed that it can recognize a real turn starting and then clear the signal when the turn ends. It does not turn on any indicator in the dashboard or change a person's normal Codex session.

The experiment also found an important limit. A fresh session behaved the same with and without the observer, but a resumed session paused to ask for hook review. In a disposable session, explicitly approving that review let the turn continue. The ordinary resumed session continued without the extra step. Until we can explain and resolve this difference, the code stays disconnected from normal session launches.

The checkpoint is for preserving the tested work and making it possible to review it from another machine. It carries no release approval and requires separate checks before the indicator may be connected to a chat.
