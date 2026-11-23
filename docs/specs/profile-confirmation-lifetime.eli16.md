# More time to answer a change request

When you ask to move a conversation to another coding engine, Instar sends a question before changing anything. Today that question can expire after only a few minutes. Sending it again can also leave you with no visible question, and a plain yes may then arrive as ordinary conversation without explaining what happened.

This repair gives those requests a provisional full-day response window and shows the exact deadline. A deliberate reminder remains visible, and a message from an agent does not cancel the question. Separate changes keep separate questions. Answering one cannot approve another.

The safety rule stays simple: reply directly to the delivered question with yes. A numbered answer or an answer without a link to its question changes nothing. Instar explains what happened and can send a fresh question after checking the change. Older recovery questions must also be linked to their actual delivered message, so a yes cannot accidentally spend another approval.

The repair keeps saved settings separate from what happens afterward. If settings save but restarting the conversation fails, the answer must say that clearly. Sending the same reply again must not save or restart twice. A server restart loses old approval authority; Instar checks the current state before asking again, rather than trusting an old saved approval.

Independent review comes before the build. Tests will cover late answers, failed sends, overlapping questions and failures after a save. A live demo will exercise the real Telegram path and the required Slack baseline. The normal complete verification queue must also pass before merge. Until those checks finish, this is a repair in progress, not a released change.
