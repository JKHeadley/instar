# What the real Telegram test established

The confirmation change has now been exercised through Telegram by a signed-in user browser and a real bot. The test used an isolated demo group and a throwaway agent. It did not post to the operator's working conversations or open their chat screens. The source conversation used Claude for this exercise because a separate delivery problem prevented a fresh Codex session from accepting its next message safely. That delivery problem remains assigned to its own repair lane.

The test left two changes waiting at once. A numbered yes changed nothing and produced one server-issued reminder. A native yes to the first question changed only its destination. A native yes to the reminder changed the second destination. Messages from the agent between the questions and answers did not cancel the waiting requests. The asking conversation retained its settings.

Each row points to actual Telegram message IDs. The runner wrote a signed artifact, and the built runtime hashes inside it were checked before and after the exercise. Earlier failed runs remain next to the passing result so a reviewer can see what the live test caught. This evidence does not deploy the feature or replace the full verification queue. The current commit adds documents and signatures only; it changes no runtime source, configuration, credentials or permissions.
